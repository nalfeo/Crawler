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
    'progressed',
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
