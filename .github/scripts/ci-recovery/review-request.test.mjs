import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conflictEpisodeId,
  conflictEpisodeMarker,
  executeReviewDecision,
  reviewRequestMarker,
  shouldRequestReview,
  unrecordedConflictEpisode,
} from './review-request.mjs';

const HEADS = [
  '0000000000000000000000000000000000000001',
  '0000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000003',
  '0000000000000000000000000000000000000004',
  '0000000000000000000000000000000000000005',
];
const BASES = [
  '1000000000000000000000000000000000000001',
  '1000000000000000000000000000000000000002',
];
const pr = (headSha = HEADS[1]) => ({
  state: 'open',
  draft: false,
  mergeable_state: 'clean',
  head: { sha: headSha },
  base: { sha: BASES[0] },
});
const trustedComment = (body) => ({ body, author_association: 'OWNER' });
const requestComment = (headSha, reason, episode) =>
  trustedComment(reviewRequestMarker({ headSha, reason, episode }));
const conflictComment = (headSha, baseSha) => {
  const episode = conflictEpisodeId({ headSha, baseSha });
  return trustedComment(conflictEpisodeMarker({ episode, headSha, baseSha }));
};
const decision = ({
  trigger = 'workflow_run:completed',
  currentPr = pr(),
  hasMergeConflict = false,
  requiredChecksPassing = true,
  hasInitialReviewEvidence = false,
  blockers = [],
  comments = [],
} = {}) =>
  shouldRequestReview({
    trigger,
    pr: currentPr,
    hasMergeConflict,
    requiredChecksPassing,
    hasInitialReviewEvidence,
    blockers,
    comments,
  });

test('records the platform-owned initial publish review without requesting a duplicate', () => {
  assert.deepEqual(
    decision({ trigger: 'pull_request_target:ready_for_review' }),
    { reason: 'ready', episode: null, requestReviewer: false },
  );
});

test('records a recovery-ready marker when publish-review evidence exists without markers', () => {
  assert.deepEqual(
    decision({
      trigger: 'schedule',
      hasInitialReviewEvidence: true,
    }),
    { reason: 'ready', episode: null, requestReviewer: false },
  );
});

test('allows two normal CI-green re-reviews after the publish review', () => {
  const initial = requestComment(HEADS[0], 'ready');
  assert.deepEqual(decision({ comments: [initial] }), {
    reason: 'synchronize',
    episode: null,
    requestReviewer: true,
  });
  assert.deepEqual(
    decision({ currentPr: pr(HEADS[2]), comments: [initial, requestComment(HEADS[1], 'synchronize')] }),
    { reason: 'synchronize', episode: null, requestReviewer: true },
  );
});

test('rejects a fourth normal review', () => {
  assert.equal(
    decision({
      currentPr: pr(HEADS[3]),
      comments: [
        requestComment(HEADS[0], 'ready'),
        requestComment(HEADS[1], 'synchronize'),
        requestComment(HEADS[2], 'synchronize'),
      ],
    }),
    null,
  );
});

test('rejects duplicate review requests for the same head', () => {
  assert.equal(
    decision({
      comments: [
        requestComment(HEADS[0], 'ready'),
        requestComment(HEADS[1], 'synchronize'),
      ],
    }),
    null,
  );
});

test('allows a conflict review even when the current head was already normally reviewed', () => {
  // Head H=HEADS[1] was synchronize-reviewed; a new conflict episode then arrived on
  // that same head.  The conflict-resolved review must fire even though HEADS[1] already
  // carries a normal request marker.
  const episode = conflictEpisodeId({ headSha: HEADS[1], baseSha: BASES[0] });
  assert.deepEqual(
    decision({
      currentPr: pr(HEADS[1]),
      comments: [
        requestComment(HEADS[0], 'ready'),
        requestComment(HEADS[1], 'synchronize'),
        conflictComment(HEADS[1], BASES[0]),
      ],
    }),
    { reason: 'conflict-resolved', episode, requestReviewer: true },
  );
});

test('fails closed while required checks are missing, pending, or failed', () => {
  const comments = [requestComment(HEADS[0], 'ready')];
  assert.equal(decision({ requiredChecksPassing: false, comments }), null);
  assert.equal(
    shouldRequestReview({
      trigger: 'workflow_run:completed',
      pr: pr(),
      hasMergeConflict: false,
      requiredChecksPassing: undefined,
      blockers: [],
      comments,
    }),
    null,
  );
});

test('does not request review while another policy is blocking the PR', () => {
  assert.equal(
    decision({
      blockers: [{ kind: 'review-thread' }],
      comments: [requestComment(HEADS[0], 'ready')],
    }),
    null,
  );
});

test('allows one conflict review outside an exhausted normal budget', () => {
  const conflict = conflictComment(HEADS[2], BASES[0]);
  const episode = conflictEpisodeId({ headSha: HEADS[2], baseSha: BASES[0] });
  assert.deepEqual(
    decision({
      currentPr: pr(HEADS[3]),
      comments: [
        requestComment(HEADS[0], 'ready'),
        requestComment(HEADS[1], 'synchronize'),
        requestComment(HEADS[2], 'synchronize'),
        conflict,
      ],
    }),
    { reason: 'conflict-resolved', episode, requestReviewer: true },
  );
});

test('allows exactly one review per conflict episode', () => {
  const conflict = conflictComment(HEADS[1], BASES[0]);
  const episode = conflictEpisodeId({ headSha: HEADS[1], baseSha: BASES[0] });
  assert.equal(
    decision({
      currentPr: pr(HEADS[3]),
      comments: [
        requestComment(HEADS[0], 'ready'),
        conflict,
        requestComment(HEADS[2], 'conflict-resolved', episode),
      ],
    }).reason,
    'synchronize',
  );
});

test('permits a later distinct conflict episode', () => {
  const firstEpisode = conflictEpisodeId({ headSha: HEADS[1], baseSha: BASES[0] });
  const secondEpisode = conflictEpisodeId({ headSha: HEADS[2], baseSha: BASES[1] });
  assert.deepEqual(
    decision({
      currentPr: pr(HEADS[3]),
      comments: [
        requestComment(HEADS[0], 'ready'),
        conflictComment(HEADS[1], BASES[0]),
        requestComment(HEADS[2], 'conflict-resolved', firstEpisode),
        conflictComment(HEADS[2], BASES[1]),
      ],
    }),
    { reason: 'conflict-resolved', episode: secondEpisode, requestReviewer: true },
  );
});

test('ignores spoofed, embedded, and malformed markers', () => {
  const marker = reviewRequestMarker({ headSha: HEADS[0], reason: 'ready' });
  assert.equal(
    decision({
      comments: [
        { body: marker, author_association: 'NONE' },
        trustedComment(`quoted ${marker}`),
        trustedComment(
          `${reviewRequestMarker({ headSha: HEADS[1], reason: 'synchronize' })} trailing`,
        ),
      ],
    }),
    null,
  );
});

test('records each head/base conflict identity only once', () => {
  const currentPr = pr(HEADS[1]);
  const episode = unrecordedConflictEpisode({
    pr: currentPr,
    hasMergeConflict: true,
    comments: [],
  });
  assert.deepEqual(episode, {
    episode: conflictEpisodeId({ headSha: HEADS[1], baseSha: BASES[0] }),
    headSha: HEADS[1],
    baseSha: BASES[0],
  });
  assert.equal(
    unrecordedConflictEpisode({
      pr: currentPr,
      hasMergeConflict: true,
      comments: [trustedComment(conflictEpisodeMarker(episode))],
    }),
    null,
  );
});

test('does not spend the episode review while the same-run conflict is still active', () => {
  const comments = [
    requestComment(HEADS[0], 'ready'),
    conflictComment(HEADS[1], BASES[0]),
  ];
  assert.equal(
    decision({
      currentPr: {
        ...pr(HEADS[1]),
        mergeable_state: 'dirty',
      },
      hasMergeConflict: true,
      comments,
    }),
    null,
  );
});

test('does not record clean PRs as conflict episodes', () => {
  assert.equal(
    unrecordedConflictEpisode({
      pr: pr(),
      hasMergeConflict: false,
      comments: [],
    }),
    null,
  );
});

test('persists the marker before requesting review', async () => {
  const calls = [];
  await executeReviewDecision({
    decision: { requestReviewer: true },
    marker: 'marker',
    createMarker: async () => {
      calls.push('marker');
      return { id: 42 };
    },
    deleteMarker: async () => calls.push('delete'),
    requestReviewer: async () => calls.push('review'),
  });
  assert.deepEqual(calls, ['marker', 'review']);
});

test('rolls back a marker only for deterministic reviewer-request failures', async () => {
  const calls = [];
  await assert.rejects(
    executeReviewDecision({
      decision: { requestReviewer: true },
      marker: 'marker',
      createMarker: async () => {
        calls.push('marker');
        return { id: 42 };
      },
      deleteMarker: async (id) => calls.push(`delete:${id}`),
      requestReviewer: async () => {
        calls.push('review');
        const error = new Error('review failed');
        error.markerRollbackSafe = true;
        throw error;
      },
    }),
    /review failed/,
  );
  assert.deepEqual(calls, ['marker', 'review', 'delete:42']);
});

test('keeps marker on ambiguous reviewer-request failures', async () => {
  const calls = [];
  await assert.rejects(
    executeReviewDecision({
      decision: { requestReviewer: true },
      marker: 'marker',
      createMarker: async () => {
        calls.push('marker');
        return { id: 42 };
      },
      deleteMarker: async (id) => calls.push(`delete:${id}`),
      requestReviewer: async () => {
        calls.push('review');
        const error = new Error('ambiguous failure');
        error.status = 502;
        throw error;
      },
    }),
    /ambiguous failure/,
  );
  assert.deepEqual(calls, ['marker', 'review']);
});
