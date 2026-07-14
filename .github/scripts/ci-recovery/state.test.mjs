import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOwnershipInvariant,
  blockerFingerprint,
  collapseCheckRunsByName,
  extractAddressedMarkerSha,
  hasTrustedTrainPromotionCheck,
  isDuplicateDispatch,
  isLeaseExpired,
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
} from './state.mjs';

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

test('extractAddressedMarkerSha parses raw SHA and commit URL markers', () => {
  assert.equal(extractAddressedMarkerSha('✅ Addressed in abc1234def: note'), 'abc1234def');
  assert.equal(
    extractAddressedMarkerSha(
      '✅ Addressed in <https://github.com/nalfeo/Crawler/commit/def5678abc1234ff00aa11bb22cc33dd44ee55ff>',
    ),
    'def5678abc1234ff00aa11bb22cc33dd44ee55ff',
  );
  assert.equal(extractAddressedMarkerSha('✅ Addressed in not-a-commit-link'), null);
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
