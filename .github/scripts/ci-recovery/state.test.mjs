import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOwnershipInvariant,
  blockerFingerprint,
  collapseCheckRunsByName,
  extractAddressedMarkerUrl,
  isDuplicateDispatch,
  isLeaseExpired,
  normalizeBlockers,
  ownerLabel,
  parseStateComment,
  renderStateComment,
  makeState,
  reviewThreadBlockerId,
  reviewThreadCommentDigest,
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
  assert.equal(blockerFingerprint('abc', left), blockerFingerprint('abc', right));
  assert.notEqual(blockerFingerprint('def', left), blockerFingerprint('abc', right));
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
    blockerFingerprint('abc', [blocker]),
    blockerFingerprint('abc', [{ ...blocker, id: reviewThreadBlockerId(identicalThread) }]),
  );
  assert.notEqual(
    blockerFingerprint('abc', [blocker]),
    blockerFingerprint('abc', [{ ...blocker, id: reviewThreadBlockerId(laterThread) }]),
  );
  assert.notEqual(
    blockerFingerprint('abc', [blocker]),
    blockerFingerprint('abc', [{ ...blocker, id: reviewThreadBlockerId(editedThread) }]),
  );
});

test('round trips sticky state comments', () => {
  const state = makeState({
    prNumber: 42,
    headSha: 'abc',
    fingerprint: blockerFingerprint('abc', []),
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
    fingerprint: blockerFingerprint('abc', []),
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
    fingerprint: blockerFingerprint('abc', []),
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

test('rejects duplicate dispatches for the same head and blocker fingerprint', () => {
  const first = blockerFingerprint('abc', [
    { kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' },
  ]);
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
  assert.equal(
    isDuplicateDispatch(
      state,
      blockerFingerprint('def', [{ kind: 'ci-failure', id: 'ci:1', summary: 'CI failed' }]),
    ),
    false,
  );
});

test('shouldResolveThread rejects old marker with later reviewer comment', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: '✅ Addressed in https://github.com/nalfeo/Crawler/pull/1122#discussion_r1: fixed it',
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
  assert.equal(
    shouldResolveThread(thread, { owner: 'nalfeo', repo: 'Crawler', prNumber: 1122 }),
    false,
  );
});

test('shouldResolveThread rejects marker link to different PR', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: '✅ Addressed in https://github.com/nalfeo/Crawler/pull/999#discussion_r99: fixed',
          authorAssociation: 'OWNER',
          author: { login: 'dev' },
        },
      ],
    },
  };
  assert.equal(
    shouldResolveThread(thread, { owner: 'nalfeo', repo: 'Crawler', prNumber: 1122 }),
    false,
  );
});

test('shouldResolveThread accepts latest trusted same-PR discussion link', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: 'Needs fixing.',
          authorAssociation: 'COLLABORATOR',
          author: { login: 'reviewer' },
        },
        {
          body: '✅ Addressed in <https://github.com/nalfeo/Crawler/pull/1122#discussion_r12345>: resolved the issue',
          authorAssociation: 'OWNER',
          author: { login: 'dev' },
        },
      ],
    },
  };
  assert.equal(
    shouldResolveThread(thread, { owner: 'nalfeo', repo: 'Crawler', prNumber: 1122 }),
    true,
  );
});

test('extractAddressedMarkerUrl parses URL marker token', () => {
  const parsed = extractAddressedMarkerUrl(
    '✅ Addressed in <https://github.com/nalfeo/Crawler/pull/1122#discussion_r12345>: note',
  );
  assert.equal(parsed?.hostname, 'github.com');
  assert.equal(parsed?.pathname, '/nalfeo/Crawler/pull/1122');
  assert.equal(parsed?.hash, '#discussion_r12345');
});

test('extractAddressedMarkerUrl rejects non-URL token', () => {
  assert.equal(extractAddressedMarkerUrl('✅ Addressed in abc1234def: note'), null);
});

test('shouldResolveThread rejects non-URL token marker', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: '✅ Addressed in abc1234def: note',
          authorAssociation: 'OWNER',
          author: { login: 'dev' },
        },
      ],
    },
  };
  assert.equal(
    shouldResolveThread(thread, { owner: 'nalfeo', repo: 'Crawler', prNumber: 1122 }),
    false,
  );
});

test('shouldResolveThread rejects same-PR non-discussion URL marker', () => {
  const thread = {
    comments: {
      nodes: [
        {
          body: '✅ Addressed in https://github.com/nalfeo/Crawler/pull/1122: note',
          authorAssociation: 'OWNER',
          author: { login: 'dev' },
        },
      ],
    },
  };
  assert.equal(
    shouldResolveThread(thread, { owner: 'nalfeo', repo: 'Crawler', prNumber: 1122 }),
    false,
  );
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
