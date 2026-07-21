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
    { body: reviewRequestMarker({ headSha: 'head-0', reason: 'synchronize' }) },
    { body: reviewRequestMarker({ headSha: 'head-1', reason: 'synchronize' }) },
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
        { body: reviewRequestMarker({ headSha: 'old-head', reason: 'synchronize' }) },
        { body: reviewRequestMarker({ headSha: 'old-head-2', reason: 'synchronize' }) },
      ],
      previousState: { blockers: [{ kind: 'merge-conflict' }] },
    }),
    'conflict-resolved',
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
