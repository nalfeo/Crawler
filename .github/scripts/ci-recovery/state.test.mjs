import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admissionWaitReasons,
  assertOwnershipInvariant,
  automationProgressKey,
  automationStallAction,
  blockerFingerprint,
  collapseCheckRunsByName,
  extractAddressedMarkerSha,
  hasNotApplicableMarker,
  hasSubstantiveCopilotReview,
  hasTrustedTrainPromotionCheck,
  isDuplicateDispatch,
  isHealthyRecoveryOwner,
  isLeaseExpired,
  isRecoveryStateSemanticallyEqual,
  isTrainFastPathPushRun,
  isTrustedTrainPromotionCheck,
  makeState,
  reviewThreadBlockerId,
  reviewThreadCommentDigest,
  markerNamesHead,
  normalizeBlockers,
  ownerLabel,
  parseStateComment,
  renderStateComment,
  shouldResolveThread,
  shouldSkipRepoIncidentWorkflowRun,
  shouldMutateRecoveryState,
  shouldDispatchMergeTrainFill,
  ABANDON_CANDIDATE_LABEL,
  QUARANTINE_COMMENT_MARKER,
  parseDispositionCommand,
  WAITING_LABEL,
  WAITING_TRANSITION_LABEL,
} from './state.mjs';

test('requires a submitted substantive Copilot code review', () => {
  const review = {
    author: { login: 'copilot-pull-request-reviewer' },
    state: 'COMMENTED',
    body: 'Reviewed 3 files and found no blocking issues.',
    comments: { nodes: [] },
  };

  assert.equal(hasSubstantiveCopilotReview([review]), true);
  assert.equal(
    hasSubstantiveCopilotReview([
      {
        ...review,
        body: "Copilot wasn't able to review any files in this pull request.",
      },
    ]),
    false,
  );
  assert.equal(hasSubstantiveCopilotReview([{ ...review, body: '   ' }]), false);
  assert.equal(
    hasSubstantiveCopilotReview([
      {
        ...review,
        body: '',
        comments: { nodes: [{ body: 'Potential null dereference on this line.' }] },
      },
    ]),
    true,
  );
});

test('rejects pending, dismissed, and non-Copilot reviews', () => {
  const review = {
    author: { login: 'copilot-pull-request-reviewer[bot]' },
    state: 'COMMENTED',
    body: 'Substantive review',
    comments: { nodes: [] },
  };

  assert.equal(hasSubstantiveCopilotReview([{ ...review, state: 'PENDING' }]), false);
  assert.equal(hasSubstantiveCopilotReview([{ ...review, state: 'DISMISSED' }]), false);
  assert.equal(
    hasSubstantiveCopilotReview([{ ...review, author: { login: 'some-other-reviewer[bot]' } }]),
    false,
  );
});

test('admission waits for both required checks and a substantive historical review', () => {
  const noFilesReview = {
    author: { login: 'copilot-pull-request-reviewer' },
    state: 'COMMENTED',
    body: "Copilot wasn't able to review any files in this pull request.",
    comments: { nodes: [] },
  };
  const substantiveReview = {
    ...noFilesReview,
    body: 'Reviewed the pull request.',
  };

  assert.deepEqual(admissionWaitReasons(['ci'], [noFilesReview]), [
    'ci',
    'substantive-copilot-review',
  ]);
  assert.deepEqual(admissionWaitReasons([], [substantiveReview]), []);
});

test('normalizes blocker order before fingerprinting', () => {
  const left = [
    { kind: 'review-thread', id: 'B', summary: ' second  finding ' },
    { kind: 'ci-failure', id: 'A', summary: ' failed\n check ' },
  ];
  const right = [...left].reverse();

  assert.deepEqual(normalizeBlockers(left), normalizeBlockers(right));
  // Blocker order is normalised before hashing — same items regardless of insertion order.
  assert.equal(blockerFingerprint(left), blockerFingerprint(right));
});

test('normalizeBlockers preserves isOutdated flag and it is included in the fingerprint', () => {
  const fresh = { kind: 'review-thread', id: 'rt:abc:000', summary: 'finding', path: 'foo.ts' };
  const outdated = { ...fresh, isOutdated: true };

  // isOutdated:true must survive normalisation
  const normalizedOutdated = normalizeBlockers([outdated]);
  assert.equal(normalizedOutdated[0].isOutdated, true);

  // isOutdated:false / absent must NOT set the field (stays absent)
  const normalizedFresh = normalizeBlockers([fresh]);
  assert.equal(normalizedFresh[0].isOutdated, undefined);

  // fingerprints must differ between outdated and fresh so the automation
  // resets the retry budget when a thread transitions to outdated state
  assert.notEqual(blockerFingerprint([fresh]), blockerFingerprint([outdated]));
});

test('line-number drift does not change the blocker fingerprint', () => {
  // Regression: diff-position line numbers drift whenever surrounding code is
  // modified (e.g. INDEX.md regenerated).  Including `line` in normalizeBlockers
  // previously caused a new fingerprint on every line-shift, which
  // automationStallAction interpreted as 'progressed' and reset the attempt
  // counter — granting a fresh retry budget for the same underlying blocker and
  // creating an infinite recovery loop (CI recovery loop incident pattern).
  const base = {
    kind: 'review-thread',
    id: 'review-thread:PRRT_test:abcdef1234',
    summary: 'reviewer: handoff landing in _unclassified_',
    path: 'docs/knowledge/handoffs/INDEX.md',
    line: 488,
  };
  const shifted = { ...base, line: 497 };
  const noLine = { ...base, line: undefined };
  const normalizedBase = normalizeBlockers([base])[0];
  const normalizedShifted = normalizeBlockers([shifted])[0];

  assert.equal(blockerFingerprint([base]), blockerFingerprint([shifted]));
  assert.equal(blockerFingerprint([base]), blockerFingerprint([noLine]));
  assert.equal(normalizedBase.line, 488);
  assert.equal(normalizedShifted.line, 497);
  // line should remain available for display metadata even though hashing ignores it
  assert.notEqual(normalizedBase.line, normalizedShifted.line);
});

test('check-run/workflow-run URL drift does not change the blocker fingerprint', () => {
  // Regression (production incident, PR #1809, 2026-07-23): a `ci-failure` or
  // `ci-retrigger` blocker's `url` is a check-run/workflow-run permalink that
  // embeds a fresh run/job ID on every rerun of the SAME failing check (same
  // name, same conclusion) -- including retries dispatched by this very
  // automation. Including `url` in the fingerprint hash meant every retry
  // cycle produced a NEW fingerprint even though nothing about the underlying
  // blocker changed. `automationStallAction` reads a changed fingerprint as
  // `'progressed'`, which resets the attempt counter and refreshes
  // `progressAt` to now on every cycle -- so the stale-automation ceiling
  // (attempt >= 2) and the lease-reaper takeover window could never be
  // reached, producing an effectively immortal automation ownership lock
  // (observed as a 10:09 / 10:44 / 11:29 UTC no-progress cycle with `attempt`
  // pinned at 1 forever).
  const base = {
    kind: 'ci-failure',
    id: 'copilot',
    summary: 'copilot concluded failure.',
    url: 'https://github.com/nalfeo/Crawler/actions/runs/3000042805/job/8918406660',
  };
  const rerun = {
    ...base,
    url: 'https://github.com/nalfeo/Crawler/actions/runs/3000099999/job/8918499999',
  };
  const noUrl = { ...base, url: undefined };

  assert.equal(blockerFingerprint([base]), blockerFingerprint([rerun]));
  assert.equal(blockerFingerprint([base]), blockerFingerprint([noUrl]));

  // url must remain available for display metadata even though hashing ignores it.
  const normalizedBase = normalizeBlockers([base])[0];
  const normalizedRerun = normalizeBlockers([rerun])[0];
  assert.equal(normalizedBase.url, base.url);
  assert.equal(normalizedRerun.url, rerun.url);
  assert.notEqual(normalizedBase.url, normalizedRerun.url);
});

test('ci-retrigger blocker URL drift (workflow-run rerun of a parked action_required check) does not change the fingerprint', () => {
  // Plan-review follow-up: the fix must cover EVERY url-bearing blocker kind,
  // not just `ci-failure`. `ci-retrigger` blockers (reconcile.mjs, action_required
  // workflow runs parked on the same App identity) set `url: run.html_url` --
  // a workflow-run permalink that also embeds a new run id on every rerun of
  // the same parked check, with `id`/`summary` unchanged.
  const base = {
    kind: 'ci-retrigger',
    id: 'action-required:build',
    summary:
      'build is parked in action_required because the commit was pushed by the same App identity. Push one commit under a different identity to retrigger CI.',
    url: 'https://github.com/nalfeo/Crawler/actions/runs/4000000001',
  };
  const rerun = {
    ...base,
    url: 'https://github.com/nalfeo/Crawler/actions/runs/4000000002',
  };

  assert.equal(
    blockerFingerprint([base]),
    blockerFingerprint([rerun]),
    'ci-retrigger fingerprint must be stable across a workflow-run rerun with only the url changed',
  );
  const normalizedRerun2 = normalizeBlockers([rerun])[0];
  assert.equal(normalizedRerun2.url, rerun.url, 'url must still be preserved for display');
});

test('automationStallAction treats a same-fingerprint, different-url retry as wait/retry, never progressed', () => {
  // Direct regression for the automation-liveness bug: a retry with only the
  // check-run URL changed must climb the existing stale-retry ceiling
  // (wait -> retry -> release) instead of being classified as 'progressed',
  // which would reset the retry budget forever.
  const blockersRun1 = [
    {
      kind: 'ci-failure',
      id: 'copilot',
      summary: 'copilot concluded failure.',
      url: 'https://github.com/nalfeo/Crawler/actions/runs/1/job/1',
    },
  ];
  const blockersRun2 = [
    {
      ...blockersRun1[0],
      url: 'https://github.com/nalfeo/Crawler/actions/runs/2/job/2',
    },
  ];
  const fingerprintRun1 = blockerFingerprint(blockersRun1);
  const fingerprintRun2 = blockerFingerprint(blockersRun2);
  assert.equal(
    fingerprintRun1,
    fingerprintRun2,
    'fingerprint must be identical across reruns of the same check with a new url',
  );

  const headSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const now = new Date('2026-07-23T11:29:10.524Z');

  // Cycle 1 (10:09 UTC equivalent): freshly dispatched, not yet stale.
  const freshState = makeState({
    prNumber: 1809,
    headSha,
    fingerprint: fingerprintRun1,
    owner: 'automation',
    status: 'dispatched',
    blockers: blockersRun1,
    attempt: 1,
    progressKey: automationProgressKey(headSha, fingerprintRun1),
    progressAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    updatedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
  });
  assert.equal(
    automationStallAction({ state: freshState, fingerprint: fingerprintRun2, now }),
    'wait',
    'a fresh, non-stale duplicate must wait even when the url-only blocker changed',
  );

  // Cycle 2 (10:44 UTC equivalent): stale by >30 min, attempt=1 -> retry.
  const staleAttempt1State = makeState({
    ...freshState,
    prNumber: 1809,
    headSha,
    fingerprint: fingerprintRun1,
    owner: 'automation',
    status: 'dispatched',
    blockers: blockersRun1,
    attempt: 1,
    progressKey: automationProgressKey(headSha, fingerprintRun1),
    progressAt: new Date(now.getTime() - 35 * 60 * 1000).toISOString(),
    updatedAt: new Date(now.getTime() - 35 * 60 * 1000).toISOString(),
  });
  assert.equal(
    automationStallAction({ state: staleAttempt1State, fingerprint: fingerprintRun2, now }),
    'retry',
    'a stale duplicate at attempt=1 must retry, not progressed, when only the url changed',
  );

  // Cycle 3 (11:29 UTC equivalent): stale by >30 min, attempt=2 -> release
  // (exhausted). This is the takeover-eligibility gate: a dead automation
  // must become releasable within a bounded number of cycles instead of
  // looping forever.
  const staleAttempt2State = makeState({
    ...staleAttempt1State,
    attempt: 2,
  });
  assert.equal(
    automationStallAction({ state: staleAttempt2State, fingerprint: fingerprintRun2, now }),
    'release',
    'after the retry ceiling, a same-fingerprint url-only change must release rather than loop forever',
  );
});

test('ci-failure copilot is excluded from the blocker fingerprint so its first appearance after a dispatch cannot trigger blocker-progressed', () => {
  // Production incident regression (PR #1939 / issue #2268, 2026-07-29): when
  // CI Recovery dispatches @copilot to fix a PR and the session fails at
  // session.create (e.g. model "claude-sonnet-4.5" deprecated), GitHub creates
  // a check named "copilot" that concludes `failure`. On the next reconcile
  // sweep this check FIRST APPEARS as a NEW `ci-failure copilot` blocker
  // alongside the original review-thread blockers. Including it in the
  // fingerprint caused `automationStallAction` to return 'progressed' —
  // resetting the attempt counter on the first failed dispatch. Excluding it
  // from the fingerprint lets the stale-retry ceiling count correctly.
  const reviewThread = {
    kind: 'review-thread',
    id: 'review-thread:PRRT_kwDOSvo2Ms6Tt_4M:abc123abc123abc123',
    summary: 'copilot-pull-request-reviewer: Please fix this.',
  };
  const copilotFailure = {
    kind: 'ci-failure',
    id: 'copilot',
    summary: 'copilot concluded failure.',
    url: 'https://github.com/nalfeo/Crawler/actions/runs/30410219329/job/90444419451',
  };

  // The fingerprint of [review-thread] must equal the fingerprint of
  // [ci-failure copilot, review-thread] — the copilot failure must not
  // change the fingerprint even when it first appears after a dispatch.
  assert.equal(
    blockerFingerprint([reviewThread]),
    blockerFingerprint([copilotFailure, reviewThread]),
    'ci-failure copilot must not participate in the fingerprint; its first appearance must not trigger blocker-progressed',
  );

  // Verify the symmetric case: [copilot + thread] === [thread] regardless of order.
  assert.equal(
    blockerFingerprint([copilotFailure, reviewThread]),
    blockerFingerprint([reviewThread, copilotFailure]),
    'fingerprint must be order-independent (normalizeBlockers sorts by kind+id)',
  );

  // A different ci-failure (non-copilot) MUST still change the fingerprint.
  const otherCiFailure = {
    kind: 'ci-failure',
    id: 'ci',
    summary: 'ci concluded failure.',
    url: 'https://github.com/nalfeo/Crawler/actions/runs/11111/job/22222',
  };
  assert.notEqual(
    blockerFingerprint([reviewThread]),
    blockerFingerprint([otherCiFailure, reviewThread]),
    'a non-copilot ci-failure must still change the fingerprint',
  );
});

test('review-thread blocker identity changes when comments change', () => {
  const baseThread = {
    id: 'thread-1',
    comments: {
      nodes: [
        {
          id: 'comment-1',
          body: 'Root finding',
          author: { login: 'dev' },
          authorAssociation: 'OWNER',
        },
      ],
    },
  };
  const identicalThread = {
    id: 'thread-1',
    comments: {
      nodes: [
        {
          id: 'comment-1',
          body: 'Root finding',
          author: { login: 'dev' },
          authorAssociation: 'OWNER',
        },
      ],
    },
  };
  const laterThread = {
    id: 'thread-1',
    comments: {
      nodes: [
        {
          id: 'comment-1',
          body: 'Root finding',
          author: { login: 'dev' },
          authorAssociation: 'OWNER',
        },
        {
          id: 'comment-2',
          body: 'Follow-up',
          author: { login: 'reviewer' },
          authorAssociation: 'MEMBER',
        },
      ],
    },
  };
  const editedThread = {
    id: 'thread-1',
    comments: {
      nodes: [
        {
          id: 'comment-1',
          body: 'Root finding, edited',
          author: { login: 'dev' },
          authorAssociation: 'OWNER',
        },
      ],
    },
  };
  const recoveryNoMarkerReplyThread = {
    id: 'thread-1',
    comments: {
      nodes: [
        {
          id: 'comment-1',
          body: 'Root finding',
          author: { login: 'dev' },
          authorAssociation: 'OWNER',
        },
        {
          id: 'comment-2',
          body: 'Still unresolved; this needs an external waiver.',
          author: { login: 'copilot-swe-agent' },
          authorAssociation: 'NONE',
        },
      ],
    },
  };
  const recoveryMarkerReplyThread = {
    id: 'thread-1',
    comments: {
      nodes: [
        {
          id: 'comment-1',
          body: 'Root finding',
          author: { login: 'dev' },
          authorAssociation: 'OWNER',
        },
        {
          id: 'comment-2',
          body: '✅ Not applicable: requires explicit maintainer waiver outside this branch',
          author: { login: 'copilot-swe-agent' },
          authorAssociation: 'NONE',
        },
      ],
    },
  };
  // A recovery reply that only quotes a prior task body containing a marker —
  // the marker lives entirely in quoted "> " lines and must NOT be treated as a
  // resolution marker (would recreate the churn loop this PR fixes).
  const recoveryQuotedMarkerReplyThread = {
    id: 'thread-1',
    comments: {
      nodes: [
        {
          id: 'comment-1',
          body: 'Root finding',
          author: { login: 'dev' },
          authorAssociation: 'OWNER',
        },
        {
          id: 'comment-2',
          body: '> ✅ Addressed in abc1234: prior fix\n\nStill blocked; the quoted marker above is from a prior task, not a resolution.',
          author: { login: 'copilot-swe-agent' },
          authorAssociation: 'NONE',
        },
      ],
    },
  };
  // A recovery reply with an invalid (non-SHA) marker token must NOT be treated
  // as a resolution marker.
  const recoveryInvalidTokenMarkerThread = {
    id: 'thread-1',
    comments: {
      nodes: [
        {
          id: 'comment-1',
          body: 'Root finding',
          author: { login: 'dev' },
          authorAssociation: 'OWNER',
        },
        {
          id: 'comment-2',
          body: '✅ Addressed in not-a-valid-sha: this token is invalid',
          author: { login: 'copilot-swe-agent' },
          authorAssociation: 'NONE',
        },
      ],
    },
  };
  const blocker = {
    kind: 'review-thread',
    id: reviewThreadBlockerId(baseThread),
    threadId: baseThread.id,
    summary: 'root finding',
  };

  assert.equal(reviewThreadCommentDigest(baseThread), reviewThreadCommentDigest(identicalThread));
  assert.notEqual(reviewThreadCommentDigest(baseThread), reviewThreadCommentDigest(laterThread));
  assert.notEqual(reviewThreadCommentDigest(baseThread), reviewThreadCommentDigest(editedThread));
  assert.equal(
    reviewThreadCommentDigest(baseThread),
    reviewThreadCommentDigest(recoveryNoMarkerReplyThread),
  );
  assert.notEqual(
    reviewThreadCommentDigest(baseThread),
    reviewThreadCommentDigest(recoveryMarkerReplyThread),
  );
  // quoted-marker recovery reply must NOT change digest
  assert.equal(
    reviewThreadCommentDigest(baseThread),
    reviewThreadCommentDigest(recoveryQuotedMarkerReplyThread),
  );
  // invalid-token marker recovery reply must NOT change digest
  assert.equal(
    reviewThreadCommentDigest(baseThread),
    reviewThreadCommentDigest(recoveryInvalidTokenMarkerThread),
  );
  assert.equal(
    blockerFingerprint([blocker]),
    blockerFingerprint([{ ...blocker, id: reviewThreadBlockerId(identicalThread) }]),
  );
  assert.notEqual(
    blockerFingerprint([blocker]),
    blockerFingerprint([{ ...blocker, id: reviewThreadBlockerId(laterThread) }]),
  );
  assert.notEqual(
    blockerFingerprint([blocker]),
    blockerFingerprint([{ ...blocker, id: reviewThreadBlockerId(editedThread) }]),
  );
  assert.equal(
    blockerFingerprint([blocker]),
    blockerFingerprint([{ ...blocker, id: reviewThreadBlockerId(recoveryNoMarkerReplyThread) }]),
  );
  assert.notEqual(
    blockerFingerprint([blocker]),
    blockerFingerprint([{ ...blocker, id: reviewThreadBlockerId(recoveryMarkerReplyThread) }]),
  );
  assert.equal(
    blockerFingerprint([blocker]),
    blockerFingerprint([
      { ...blocker, id: reviewThreadBlockerId(recoveryQuotedMarkerReplyThread) },
    ]),
  );
  assert.equal(
    blockerFingerprint([blocker]),
    blockerFingerprint([
      { ...blocker, id: reviewThreadBlockerId(recoveryInvalidTokenMarkerThread) },
    ]),
  );
});

test('round trips sticky state comments', () => {
  const state = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint([]),
    owner: 'automation',
    status: 'active',
    blockers: [],
    updatedAt: '2026-07-11T12:00:00.000Z',
  });

  assert.deepEqual(parseStateComment(renderStateComment(state)), state);
});

test('waiting state is non-owning and semantic equality ignores timestamp and trigger churn', () => {
  const waiting = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint([]),
    owner: 'none',
    status: 'waiting',
    trigger: 'schedule:sweep',
    blockers: [],
    updatedAt: '2026-07-11T12:00:00.000Z',
  });
  const directRecheck = makeState({
    ...waiting,
    trigger: 'workflow_run:completed',
    updatedAt: '2026-07-11T12:10:00.000Z',
  });

  assert.equal(WAITING_LABEL, 'ci-recovery-waiting');
  assert.equal(WAITING_TRANSITION_LABEL, 'ci-recovery-waiting-transition');
  assert.equal(isRecoveryStateSemanticallyEqual(waiting, directRecheck), true);
  assert.throws(
    () => makeState({ ...waiting, owner: 'automation' }),
    /waiting recovery state cannot own/,
  );
});

test('empty idle state ignores non-behavioral trigger churn but preserves behavioral fields', () => {
  const idle = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint([]),
    owner: 'none',
    status: 'idle',
    trigger: 'converged',
    blockers: [],
    attempt: 1,
    updatedAt: '2026-07-11T12:00:00.000Z',
  });

  assert.equal(
    isRecoveryStateSemanticallyEqual(idle, {
      ...idle,
      trigger: 'pr-open',
      updatedAt: '2026-07-11T12:10:00.000Z',
    }),
    true,
  );
  assert.equal(isRecoveryStateSemanticallyEqual(idle, { ...idle, attempt: 2 }), false);
});

test('owning state timestamp churn remains semantically unchanged outside explicit lease persistence', () => {
  const expired = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: 'lease-1',
    trigger: 'lease-acquire',
    blockers: [],
    updatedAt: '2026-07-11T12:00:00.000Z',
  });
  const reacquired = makeState({
    ...expired,
    updatedAt: '2026-07-11T13:00:00.000Z',
  });

  assert.equal(isRecoveryStateSemanticallyEqual(expired, reacquired), true);
});

test('merge-train-cumulative-conflict trigger is preserved in semantic equality (regression: thread 2)', () => {
  const converged = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint([]),
    owner: 'none',
    status: 'idle',
    trigger: 'converged',
    blockers: [],
    updatedAt: '2026-07-11T12:00:00.000Z',
  });
  const cumulativeConflict = makeState({
    ...converged,
    trigger: 'merge-train-cumulative-conflict:99',
    updatedAt: '2026-07-11T12:05:00.000Z',
  });

  // The cumulative-conflict trigger carries behavioral state (predecessor PR
  // number) that reconcile reads back. It must NOT be normalized to 'idle'.
  assert.equal(isRecoveryStateSemanticallyEqual(converged, cumulativeConflict), false);

  // Two identical cumulative-conflict triggers should be equal (no churn).
  assert.equal(
    isRecoveryStateSemanticallyEqual(cumulativeConflict, {
      ...cumulativeConflict,
      updatedAt: '2026-07-11T12:10:00.000Z',
    }),
    true,
  );

  // Non-behavioral idle triggers still normalize (no churn for sweep/converged).
  assert.equal(
    isRecoveryStateSemanticallyEqual(converged, {
      ...converged,
      trigger: 'schedule:sweep',
      updatedAt: '2026-07-11T12:10:00.000Z',
    }),
    true,
  );
});

test('enforces ownership label and state consistency', () => {
  const active = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: 'lease-1',
    blockers: [],
    updatedAt: '2026-07-11T12:00:00.000Z',
  });

  assert.doesNotThrow(() => assertOwnershipInvariant({ labelExists: true, state: active }));
  assert.throws(
    () => assertOwnershipInvariant({ labelExists: false, state: active }),
    /inconsistent/,
  );
});

test('expires shepherd leases after TTL plus queue grace', () => {
  const state = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: 'lease-1',
    blockers: [],
    updatedAt: '2026-07-11T12:00:00.000Z',
  });

  assert.equal(isLeaseExpired(state, new Date('2026-07-11T12:34:59.000Z')), false);
  assert.equal(isLeaseExpired(state, new Date('2026-07-11T12:35:01.000Z')), true);
  assert.equal(ownerLabel(42), 'ci-owner-pr-42');
});

test('lease operations persist while automated recovery is in dry-run mode', () => {
  assert.equal(shouldMutateRecoveryState('dry-run', 'lease-acquire'), true);
  assert.equal(shouldMutateRecoveryState('dry-run', 'lease-heartbeat'), true);
  assert.equal(shouldMutateRecoveryState('dry-run', 'lease-release'), true);
  assert.equal(shouldMutateRecoveryState('dry-run', 'reconcile'), false);
  assert.equal(shouldMutateRecoveryState('live', 'reconcile'), true);
  assert.equal(shouldMutateRecoveryState('off', 'lease-acquire'), false);
});

test('rejects duplicate dispatches for the same blocker fingerprint regardless of headSha', () => {
  const first = blockerFingerprint([{ kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' }]);
  const state = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: first,
    owner: 'automation',
    status: 'dispatched',
    blockers: [{ kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' }],
    updatedAt: '2026-07-11T12:00:00.000Z',
  });

  assert.equal(isDuplicateDispatch(state, first), true);
  // A mechanical rebase changes headSha but not the blockers — same fingerprint, duplicate.
  assert.equal(
    isDuplicateDispatch(
      state,
      blockerFingerprint([{ kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' }]),
    ),
    true,
  );
  // A new blocker appearing (e.g. CI failure name changed) produces a different fingerprint.
  assert.equal(
    isDuplicateDispatch(
      state,
      blockerFingerprint([{ kind: 'ci-failure', id: 'ci:2', summary: 'CI failed' }]),
    ),
    false,
  );
});

test('automation staleness waits, retries once, then releases without treating writes as progress', () => {
  const fingerprint = blockerFingerprint([
    { kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' },
  ]);
  const progressKey = automationProgressKey('abc', fingerprint);
  const state = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers: [{ kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' }],
    attempt: 1,
    progressKey,
    progressAt: '2026-07-17T12:00:00.000Z',
    updatedAt: '2026-07-17T12:20:00.000Z',
  });

  assert.equal(
    automationStallAction({
      state,
      headSha: 'abc',
      fingerprint,
      now: new Date('2026-07-17T12:29:59.000Z'),
    }),
    'wait',
  );
  assert.equal(
    automationStallAction({
      state,
      headSha: 'abc',
      fingerprint,
      now: new Date('2026-07-17T12:30:01.000Z'),
    }),
    'retry',
  );
  assert.equal(
    automationStallAction({
      state: { ...state, attempt: 2 },
      headSha: 'abc',
      fingerprint,
      now: new Date('2026-07-17T12:30:01.000Z'),
    }),
    'release',
  );
  assert.equal(
    automationStallAction({
      state,
      headSha: 'def',
      fingerprint,
      now: new Date('2026-07-17T13:00:00.000Z'),
    }),
    'retry',
  );
});

test('automation staleness keeps retry budget when only headSha changes', () => {
  const fingerprint = blockerFingerprint([
    { kind: 'review-thread', id: 'review-thread:PRRT_test:abcd', summary: 'Review finding' },
  ]);
  const state = makeState({
    prNumber: 42,
    headSha: 'old-head',
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers: [
      { kind: 'review-thread', id: 'review-thread:PRRT_test:abcd', summary: 'Review finding' },
    ],
    attempt: 2,
    progressKey: automationProgressKey('old-head', fingerprint),
    progressAt: '2026-07-17T12:00:00.000Z',
    updatedAt: '2026-07-17T12:20:00.000Z',
  });

  assert.equal(
    automationStallAction({
      state,
      headSha: 'new-head',
      fingerprint,
      now: new Date('2026-07-17T13:00:00.000Z'),
    }),
    'release',
  );
});

test('legacy state without progressKey is never exhausted regardless of historical attempt count', () => {
  // Regression for Thread 5 (PRRT_kwDOSvo2Ms6Rv6pU): legacy automation states
  // have no progressKey and carry a historical cumulative attempt count that must
  // NOT trigger the new progressKey-scoped exhaustion gate (attempt>=2 → release).
  // Such states should always resolve to 'retry' so they get at least one more
  // chance under the new per-progress-key budget.
  const fingerprint = blockerFingerprint([
    { kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' },
  ]);
  const legacyStateAttempt2 = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers: [{ kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' }],
    attempt: 2,
    // No progressKey / progressAt — legacy state
    updatedAt: '2026-07-17T12:00:00.000Z',
  });
  const legacyStateAttempt5 = { ...legacyStateAttempt2, attempt: 5 };

  // Fresh enough — should wait regardless of attempt
  assert.equal(
    automationStallAction({
      state: legacyStateAttempt2,
      headSha: 'abc',
      fingerprint,
      now: new Date('2026-07-17T12:10:00.000Z'),
    }),
    'wait',
    'legacy attempt=2 within window should wait',
  );
  // Stale — legacy state with attempt=2 must retry, not release
  assert.equal(
    automationStallAction({
      state: legacyStateAttempt2,
      headSha: 'abc',
      fingerprint,
      now: new Date('2026-07-17T12:30:01.000Z'),
    }),
    'retry',
    'legacy attempt=2 should resolve to retry, not release',
  );
  // Legacy state with very high historical attempt also retries once
  assert.equal(
    automationStallAction({
      state: legacyStateAttempt5,
      headSha: 'abc',
      fingerprint,
      now: new Date('2026-07-17T12:30:01.000Z'),
    }),
    'retry',
    'legacy attempt=5 should also resolve to retry under new semantics',
  );
});

test('broad sweeps suppress only healthy consistent owners', () => {
  const automation = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint([]),
    owner: 'automation',
    status: 'dispatched',
    blockers: [],
    attempt: 1,
    progressKey: automationProgressKey('abc', blockerFingerprint([])),
    progressAt: '2026-07-17T12:00:00.000Z',
    updatedAt: '2026-07-17T12:10:00.000Z',
  });
  const shepherd = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: 'lease-1',
    blockers: [],
    updatedAt: '2026-07-17T12:00:00.000Z',
  });

  assert.equal(
    isHealthyRecoveryOwner({
      prNumber: 42,
      state: automation,
      now: new Date('2026-07-17T12:29:59.000Z'),
    }),
    true,
  );
  assert.equal(
    isHealthyRecoveryOwner({
      prNumber: 42,
      state: automation,
      headSha: 'abc',
      now: new Date('2026-07-17T12:29:59.000Z'),
    }),
    true,
  );
  assert.equal(
    isHealthyRecoveryOwner({
      prNumber: 42,
      state: automation,
      headSha: 'def',
      now: new Date('2026-07-17T12:29:59.000Z'),
    }),
    false,
  );
  assert.equal(
    isHealthyRecoveryOwner({
      prNumber: 42,
      state: automation,
      now: new Date('2026-07-17T12:30:01.000Z'),
    }),
    false,
  );
  assert.equal(
    isHealthyRecoveryOwner({
      prNumber: 42,
      state: shepherd,
      now: new Date('2026-07-17T12:34:59.000Z'),
    }),
    true,
  );
  assert.equal(
    isHealthyRecoveryOwner({
      prNumber: 42,
      state: shepherd,
      now: new Date('2026-07-17T12:35:01.000Z'),
    }),
    false,
  );
  assert.equal(isHealthyRecoveryOwner({ prNumber: 43, state: automation }), false);
});

test('merge-train fill dispatches only on queue admission edges', () => {
  assert.equal(shouldDispatchMergeTrainFill(false), true);
  assert.equal(shouldDispatchMergeTrainFill(true), false);
});

test('shouldResolveThread rejects old marker with later reviewer comment', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: '✅ Addressed in abc1234: fixed it',
          authorAssociation: 'OWNER',
          author: { login: 'dev' },
        },
        {
          body: 'Still an issue here.',
          authorAssociation: 'MEMBER',
          author: { login: 'reviewer' },
        },
      ],
    },
  };
  assert.equal(shouldResolveThread(thread, 'abc12345678'), false);
});

test('shouldResolveThread rejects marker with wrong SHA', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: '✅ Addressed in def5678: fixed',
          authorAssociation: 'OWNER',
          author: { login: 'dev' },
        },
      ],
    },
  };
  assert.equal(shouldResolveThread(thread, 'abc12345678'), false);
});

test('shouldResolveThread accepts latest trusted marker naming current head', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: 'Needs fixing.',
          authorAssociation: 'COLLABORATOR',
          author: { login: 'reviewer' },
        },
        {
          body: '✅ Addressed in abc1234: resolved the issue',
          authorAssociation: 'OWNER',
          author: { login: 'dev' },
        },
      ],
    },
  };
  assert.equal(shouldResolveThread(thread, 'abc123456789abcdef'), true);
});

test('shouldResolveThread accepts trusted copilot-swe-agent markers without bot suffix', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: 'Needs fixing.',
          authorAssociation: 'NONE',
          author: { login: 'copilot-pull-request-reviewer' },
        },
        {
          body: '✅ Addressed in abc1234: resolved in the current head',
          authorAssociation: 'NONE',
          author: { login: 'copilot-swe-agent' },
        },
      ],
    },
  };
  assert.equal(shouldResolveThread(thread, 'abc123456789abcdef'), true);
});

test('markerNamesHead accepts full SHA and unambiguous prefix', () => {
  assert.equal(markerNamesHead('✅ Addressed in abc1234def: note', 'abc1234def0000'), true);
  assert.equal(markerNamesHead('✅ Addressed in abc1234def0000: note', 'abc1234def0000'), true);
  assert.equal(
    markerNamesHead(
      '✅ Addressed in <https://github.com/nalfeo/Crawler/commit/def5678abc1234ff00aa11bb22cc33dd44ee55ff>',
      'abc1234def0000',
      new Set(['def5678abc1234ff00aa11bb22cc33dd44ee55ff']),
    ),
    true,
  );
  assert.equal(
    markerNamesHead(
      '✅ Addressed in https://github.com/nalfeo/Crawler/commit/def5678abc1234ff00aa11bb22cc33dd44ee55ff',
      'abc1234def0000',
    ),
    false,
  );
  assert.equal(markerNamesHead('✅ Addressed in xyz9999: note', 'abc1234def0000'), false);
  assert.equal(markerNamesHead('<!-- addressed -->', 'abc1234def0000'), false);
  assert.equal(markerNamesHead('✅ Addressed in abc12: note', 'abc12345'), false); // < 7 chars
});

test('extractAddressedMarkerSha parses raw and inline-code SHA or commit URL markers', () => {
  const commitSha = 'def5678abc1234ff00aa11bb22cc33dd44ee55ff';
  const commitUrl = `https://github.com/nalfeo/Crawler/commit/${commitSha}`;
  const accepted = new Map([
    ['✅ Addressed in abc1234def: note', 'abc1234def'],
    ['✅ Addressed in abc1234def).', 'abc1234def'],
    [`✅ Addressed in <${commitUrl}>`, commitSha],
    [`✅ Addressed in ${commitUrl},`, commitSha],
    ['✅ Addressed in `abc1234def`: note', 'abc1234def'],
    ['✅ Addressed in ``abc1234def``).', 'abc1234def'],
    [`✅ Addressed in \`${commitUrl}\`: note`, commitSha],
  ]);
  for (const [body, expected] of accepted) {
    assert.equal(extractAddressedMarkerSha(body), expected, body);
  }

  const rejected = [
    '✅ Addressed in not-a-commit-link',
    '✅ Addressed in https://github.com/nalfeo/Crawler/pull/1234',
    '✅ Addressed in `abc1234def: note',
    '✅ Addressed in abc1234def`: note',
    '✅ Addressed in `abc1234`def`: note',
    '✅ Addressed in ``abc1234def`: note',
  ];
  for (const body of rejected) {
    assert.equal(extractAddressedMarkerSha(body), null, body);
  }
});

test('extractAddressedMarkerSha parses slash-separated SHA pair by taking the second (later) SHA', () => {
  // Agents sometimes write two SHAs when a fix spans multiple commits, e.g.
  // "✅ Addressed in 9adef25/28f3d0f: ...". The second (later) SHA is returned
  // so its ancestry in the lineage check proves the complete pair is present.
  assert.equal(extractAddressedMarkerSha('✅ Addressed in 9adef25/28f3d0f: note'), '28f3d0f');
  assert.equal(
    extractAddressedMarkerSha('✅ Addressed in abc1234def/def5678abc: note'),
    'def5678abc',
  );
  // Malformed: non-SHA first component → rejected.
  assert.equal(extractAddressedMarkerSha('✅ Addressed in not-a-sha/abc1234def: note'), null);
  // Malformed: non-SHA second component → rejected.
  assert.equal(extractAddressedMarkerSha('✅ Addressed in abc1234def/not-a-sha: note'), null);
  // Malformed: empty second component (trailing slash) → rejected.
  assert.equal(extractAddressedMarkerSha('✅ Addressed in abc1234def/: note'), null);
  // Malformed: more than two components → rejected (not exactly a pair).
  assert.equal(
    extractAddressedMarkerSha('✅ Addressed in abc1234def/def5678abc/extra: note'),
    null,
  );
});

test('shouldResolveThread accepts slash-separated SHA pair when second (later) SHA is a reachable ancestor', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: 'Needs fixing.',
          authorAssociation: 'NONE',
          author: { login: 'copilot-pull-request-reviewer' },
        },
        {
          body: '✅ Addressed in 9adef25/28f3d0f: Handoff and PR description fully reconciled.',
          authorAssociation: 'NONE',
          author: { login: 'copilot-swe-agent' },
        },
      ],
    },
  };
  // Second SHA in the pair is a reachable ancestor of head → should resolve.
  assert.equal(shouldResolveThread(thread, 'abc123456789abcdef', new Set(['28f3d0f'])), true);
  // Not in reachable set and not head prefix → should not resolve.
  assert.equal(shouldResolveThread(thread, 'abc123456789abcdef', new Set()), false);
  // Second SHA matches head prefix → should resolve.
  assert.equal(shouldResolveThread(thread, '28f3d0fabc123456'), true);
});

test('shouldResolveThread accepts latest trusted commit URL marker on head lineage', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: '✅ Addressed in <https://github.com/nalfeo/Crawler/commit/def5678abc1234ff00aa11bb22cc33dd44ee55ff>',
          authorAssociation: 'MEMBER',
          author: { login: 'reviewer' },
        },
      ],
    },
  };
  assert.equal(
    shouldResolveThread(
      thread,
      'abc123456789abcdef',
      new Set(['def5678abc1234ff00aa11bb22cc33dd44ee55ff']),
    ),
    true,
  );
  assert.equal(shouldResolveThread(thread, 'abc123456789abcdef', new Set()), false);
});

test('shouldResolveThread accepts trusted "✅ Not applicable" marker without a SHA', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: 'Some concern here.',
          authorAssociation: 'COLLABORATOR',
          author: { login: 'reviewer' },
        },
        {
          body: '✅ Not applicable — the path calculation is correct, two `..` segments reach the repo root.',
          authorAssociation: 'NONE',
          author: { login: 'copilot-swe-agent' },
        },
      ],
    },
  };
  assert.equal(shouldResolveThread(thread, 'abc123456789abcdef'), true);
});

test('shouldResolveThread rejects "✅ Not applicable" from untrusted author', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: '✅ Not applicable — the concern is invalid.',
          authorAssociation: 'NONE',
          author: { login: 'random-user' },
        },
      ],
    },
  };
  assert.equal(shouldResolveThread(thread, 'abc123456789abcdef'), false);
});

test('shouldResolveThread rejects "✅ Not applicable" when reviewer follows up', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: '✅ Not applicable — the finding is wrong.',
          authorAssociation: 'NONE',
          author: { login: 'copilot-swe-agent' },
        },
        {
          body: 'I disagree, the issue is still present.',
          authorAssociation: 'MEMBER',
          author: { login: 'reviewer' },
        },
      ],
    },
  };
  assert.equal(shouldResolveThread(thread, 'abc123456789abcdef'), false);
});

test('hasNotApplicableMarker recognises canonical and variant forms', () => {
  assert.equal(hasNotApplicableMarker('✅ Not applicable — reason'), true);
  assert.equal(hasNotApplicableMarker('✅ Not applicable: the path is correct'), true);
  assert.equal(hasNotApplicableMarker('✅ not applicable'), false); // bare marker — no delimiter or reason
  assert.equal(hasNotApplicableMarker('✅ NOT APPLICABLE — multi-word reason'), true);
  assert.equal(hasNotApplicableMarker('✅ Not applicable:'), false); // delimiter but empty reason
  assert.equal(hasNotApplicableMarker('✅ Not applicable:   '), false); // delimiter but whitespace-only reason
  assert.equal(hasNotApplicableMarker('✅ Not applicablex'), false); // no word boundary
  assert.equal(hasNotApplicableMarker('✅ Addressed in abc1234: note'), false);
  assert.equal(hasNotApplicableMarker('Not applicable without checkmark'), false);
  // quoted/disagreement form — marker not at start of comment
  assert.equal(
    hasNotApplicableMarker(
      "I disagree with the agent's ✅ Not applicable claim; the issue remains",
    ),
    false,
  );
  assert.equal(
    hasNotApplicableMarker(
      'The finding is valid. The agent incorrectly replied ✅ Not applicable: reason here',
    ),
    false,
  );
  assert.equal(hasNotApplicableMarker(''), false);
  assert.equal(hasNotApplicableMarker(null), false);
  assert.equal(hasNotApplicableMarker(undefined), false);
});

test('collapseCheckRunsByName keeps latest attempt by id', () => {
  const runs = [
    { id: 100, name: 'CI', status: 'completed', conclusion: 'failure' },
    { id: 200, name: 'CI', status: 'completed', conclusion: 'success' },
    { id: 150, name: 'commit-lint', status: 'completed', conclusion: 'failure' },
  ];
  const collapsed = collapseCheckRunsByName(runs);
  const byName = Object.fromEntries(collapsed.map((r) => [r.name, r]));
  assert.equal(byName['CI'].conclusion, 'success');
  assert.equal(byName['CI'].id, 200);
  assert.equal(byName['commit-lint'].id, 150);
  assert.equal(collapsed.length, 2);
});

test('skips repository incidents for PR-linked workflow runs', () => {
  assert.equal(
    shouldSkipRepoIncidentWorkflowRun({
      event: 'pull_request',
      pull_requests: [],
    }),
    true,
  );
  assert.equal(
    shouldSkipRepoIncidentWorkflowRun({
      event: 'pull_request_target',
      pull_requests: [],
    }),
    true,
  );
  assert.equal(
    shouldSkipRepoIncidentWorkflowRun({
      event: 'workflow_run',
      pull_requests: [{ number: 42 }],
    }),
    true,
  );
  assert.equal(
    shouldSkipRepoIncidentWorkflowRun({
      event: 'workflow_run',
      pull_requests: [],
    }),
    false,
  );
});

const trustedAppId = 987654;
const validExternalId = 'a'.repeat(64);

function makeTrainCheck(overrides = {}) {
  return {
    name: 'merge-train',
    status: 'completed',
    conclusion: 'success',
    app: { id: trustedAppId },
    external_id: validExternalId,
    ...overrides,
  };
}

test('isTrustedTrainPromotionCheck requires name, completion, success, app id, and fingerprint shape', () => {
  assert.equal(isTrustedTrainPromotionCheck(makeTrainCheck(), trustedAppId), true);
  assert.equal(
    isTrustedTrainPromotionCheck(makeTrainCheck({ name: 'CI' }), trustedAppId),
    false,
    'wrong check name',
  );
  assert.equal(
    isTrustedTrainPromotionCheck(makeTrainCheck({ status: 'in_progress' }), trustedAppId),
    false,
    'not completed',
  );
  assert.equal(
    isTrustedTrainPromotionCheck(makeTrainCheck({ conclusion: 'failure' }), trustedAppId),
    false,
    'not success',
  );
  assert.equal(
    isTrustedTrainPromotionCheck(makeTrainCheck({ app: { id: 1 } }), trustedAppId),
    false,
    'untrusted app id',
  );
  assert.equal(
    isTrustedTrainPromotionCheck(
      makeTrainCheck({ external_id: 'not-a-fingerprint' }),
      trustedAppId,
    ),
    false,
    'malformed external_id',
  );
  assert.equal(isTrustedTrainPromotionCheck(null, trustedAppId), false, 'null check');
  assert.equal(
    isTrustedTrainPromotionCheck(makeTrainCheck(), Number.NaN),
    false,
    'invalid trustedAppId',
  );
});

test('hasTrustedTrainPromotionCheck scans a check-run list for one trusted entry', () => {
  assert.equal(
    hasTrustedTrainPromotionCheck(
      [{ name: 'CI', status: 'completed', conclusion: 'success' }, makeTrainCheck()],
      trustedAppId,
    ),
    true,
  );
  assert.equal(
    hasTrustedTrainPromotionCheck(
      [{ name: 'CI', status: 'completed', conclusion: 'success' }],
      trustedAppId,
    ),
    false,
  );
  assert.equal(hasTrustedTrainPromotionCheck([], trustedAppId), false);
  assert.equal(hasTrustedTrainPromotionCheck(undefined, trustedAppId), false);
});

test('isTrainFastPathPushRun requires a push-triggered CI run carrying a trusted train check', () => {
  const trustedCheckRuns = [makeTrainCheck()];
  assert.equal(
    isTrainFastPathPushRun({ event: 'push', name: 'CI' }, trustedAppId, trustedCheckRuns),
    true,
  );
  assert.equal(
    isTrainFastPathPushRun({ event: 'schedule', name: 'CI' }, trustedAppId, trustedCheckRuns),
    false,
    'not a push event',
  );
  assert.equal(
    isTrainFastPathPushRun(
      { event: 'push', name: 'Security checks' },
      trustedAppId,
      trustedCheckRuns,
    ),
    false,
    'not the CI workflow',
  );
  assert.equal(
    isTrainFastPathPushRun({ event: 'push', name: 'CI' }, trustedAppId, []),
    false,
    'no trusted check present',
  );
  assert.equal(isTrainFastPathPushRun(null, trustedAppId, trustedCheckRuns), false, 'missing run');
});

test('legacy v1 automation state without progressKey is never classified as exhausted', () => {
  // Regression for Thread 3: before this PR `attempt` was a cumulative
  // dispatch count in v1 comments that have no `progressKey`. Treating
  // `attempt >= 2` as exhausted would silently skip the promised one retry
  // on all in-flight tasks immediately after rollout.  Without a stored
  // `progressKey`, the stall action must return 'retry' regardless of
  // `attempt`.
  const fingerprint = blockerFingerprint([
    { kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' },
  ]);
  const legacyState = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint,
    owner: 'automation',
    status: 'dispatched',
    blockers: [{ kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' }],
    attempt: 2,
    // Deliberately omit progressKey — this simulates a legacy v1 comment.
    updatedAt: '2026-07-01T12:00:00.000Z',
  });
  // Verify the fixture is actually missing progressKey.
  assert.equal(legacyState.progressKey, undefined);

  assert.equal(
    automationStallAction({
      state: legacyState,
      headSha: 'abc',
      fingerprint,
      now: new Date('2026-07-01T12:31:00.000Z'),
    }),
    'retry',
    'legacy v1 state with attempt>=2 but no progressKey must be retried, not released',
  );
});

// ---------------------------------------------------------------------------
// Disposition constants
// ---------------------------------------------------------------------------

test('ABANDON_CANDIDATE_LABEL is the expected label string', () => {
  assert.equal(ABANDON_CANDIDATE_LABEL, 'abandon-candidate');
});

test('QUARANTINE_COMMENT_MARKER is the expected marker string', () => {
  assert.ok(
    String(QUARANTINE_COMMENT_MARKER).startsWith('<!-- '),
    'must be an HTML comment marker',
  );
  assert.ok(QUARANTINE_COMMENT_MARKER.includes('quarantine'), 'must include "quarantine"');
});

// ---------------------------------------------------------------------------
// parseDispositionCommand — exact-match human-gated revival
// ---------------------------------------------------------------------------

test('parseDispositionCommand: "KEEP" (exact) → "KEEP"', () => {
  assert.equal(parseDispositionCommand('KEEP'), 'KEEP');
});

test('parseDispositionCommand: "ABANDON" (exact) → "ABANDON"', () => {
  assert.equal(parseDispositionCommand('ABANDON'), 'ABANDON');
});

test('parseDispositionCommand: leading/trailing whitespace is trimmed', () => {
  assert.equal(parseDispositionCommand('  KEEP  '), 'KEEP');
  assert.equal(parseDispositionCommand('\nABANDON\n'), 'ABANDON');
});

test('parseDispositionCommand: substrings do NOT match', () => {
  // "KEEP" embedded in other text must not trigger revival.
  assert.equal(parseDispositionCommand('please KEEP this PR'), null);
  assert.equal(parseDispositionCommand('KEEP this alive'), null);
  assert.equal(parseDispositionCommand('I want to KEEP it'), null);
  assert.equal(parseDispositionCommand('ABANDON this idea'), null);
  assert.equal(parseDispositionCommand('should we ABANDON?'), null);
});

test('parseDispositionCommand: lowercase or mixed-case does NOT match (case-sensitive)', () => {
  assert.equal(parseDispositionCommand('keep'), null);
  assert.equal(parseDispositionCommand('Keep'), null);
  assert.equal(parseDispositionCommand('abandon'), null);
  assert.equal(parseDispositionCommand('Abandon'), null);
});

test('parseDispositionCommand: quoted text does NOT match', () => {
  assert.equal(parseDispositionCommand('> KEEP'), null);
  assert.equal(parseDispositionCommand('`KEEP`'), null);
  assert.equal(parseDispositionCommand('"ABANDON"'), null);
});

test('parseDispositionCommand: empty, null, undefined → null', () => {
  assert.equal(parseDispositionCommand(''), null);
  assert.equal(parseDispositionCommand(null), null);
  assert.equal(parseDispositionCommand(undefined), null);
});

test('parseDispositionCommand: other valid comment text (e.g. LGTM) → null', () => {
  assert.equal(parseDispositionCommand('LGTM'), null);
  assert.equal(parseDispositionCommand('APPROVED FOR CHECK-IN'), null);
  assert.equal(parseDispositionCommand('This PR looks good'), null);
});

test('parseDispositionCommand: green CI or other-author text does NOT unlock', () => {
  // The issue states: "green CI, other authors, quoted text, or substrings do not."
  // This tests that a CI status comment (which isn't from the owner) cannot
  // accidentally parse as KEEP.  The command parser itself is agnostic to
  // author; the caller (workflow) must gate on author identity separately.
  assert.equal(parseDispositionCommand('All checks passed'), null);
  assert.equal(parseDispositionCommand('✅ CI green'), null);
});
