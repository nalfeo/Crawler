import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewRequestMarker, shouldRequestReview } from './review-request.mjs';

const pr = {
  state: 'open',
  draft: false,
  mergeable_state: 'clean',
  head: { sha: 'head-2' },
};
const passingChecks = [{ status: 'completed', conclusion: 'success' }];
const markerComment = (headSha, reason) => ({
  body: reviewRequestMarker({ headSha, reason }),
  author_association: 'OWNER',
});

test('requests review when a PR is published', () => {
  assert.equal(
    shouldRequestReview({
      trigger: 'pull_request_target:ready_for_review',
      pr,
      checkRuns: [],
      blockers: [],
      comments: [],
      previousState: null,
    }),
    'ready',
  );
});

test('requests review for only the first two passing synchronize heads', () => {
  const comments = [
    markerComment('head-0', 'synchronize'),
    markerComment('head-1', 'synchronize'),
  ];
  assert.equal(
    shouldRequestReview({
      trigger: 'pull_request_target:synchronize',
      pr,
      checkRuns: passingChecks,
      blockers: [],
      comments,
      previousState: null,
    }),
    null,
  );
});

test('requests review when a clean head resolves a prior merge conflict', () => {
  assert.equal(
    shouldRequestReview({
      trigger: 'pull_request_target:synchronize',
      pr,
      checkRuns: passingChecks,
      blockers: [],
      comments: [
        markerComment('old-head', 'synchronize'),
      ],
      previousState: { blockers: [{ kind: 'merge-conflict' }] },
    }),
    'conflict-resolved',
  );
});

test('does not request conflict-resolution review before checks pass', () => {
  assert.equal(
    shouldRequestReview({
      trigger: 'pull_request_target:synchronize',
      pr,
      checkRuns: [{ status: 'in_progress', conclusion: null }],
      blockers: [],
      comments: [],
      previousState: { blockers: [{ kind: 'merge-conflict' }] },
    }),
    null,
  );
});

test('counts conflict-resolution requests against the two synchronize requests', () => {
  assert.equal(
    shouldRequestReview({
      trigger: 'pull_request_target:synchronize',
      pr,
      checkRuns: passingChecks,
      blockers: [],
      comments: [
        markerComment('old-head', 'conflict-resolved'),
        markerComment('old-head-2', 'conflict-resolved'),
      ],
      previousState: { blockers: [{ kind: 'merge-conflict' }] },
    }),
    null,
  );
});

test('does not request review while another policy is failing', () => {
  assert.equal(
    shouldRequestReview({
      trigger: 'pull_request_target:synchronize',
      pr,
      checkRuns: passingChecks,
      blockers: [{ kind: 'ci-failure' }],
      comments: [],
      previousState: null,
    }),
    null,
  );
});
