import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowApprovalRejection } from './approval.mjs';

const repository = 'nalfeo/Crawler';
const prNumber = 42;

function rejection(overrides = {}) {
  return workflowApprovalRejection({
    repository,
    prNumber,
    prHeadRepository: repository,
    run: {
      name: 'CI Recovery Router',
      path: '.github/workflows/ci-recovery-router.yml',
      event: 'pull_request_review',
      pull_requests: [{ number: prNumber }],
      run_attempt: 1,
      ...overrides,
    },
  });
}

test('allows CI Recovery Router review events for a same-repository PR', () => {
  assert.equal(rejection(), null);
  assert.equal(rejection({ event: 'pull_request_review_comment' }), null);
});

test('allows existing CI workflows only for pull-request events', () => {
  assert.equal(rejection({ path: '.github/workflows/ci.yml', event: 'pull_request' }), null);
  assert.equal(
    rejection({ path: '.github/workflows/commit-lint.yml', event: 'pull_request_target' }),
    null,
  );
});

test('rejects fork PRs before considering an allowlisted workflow', () => {
  assert.equal(
    workflowApprovalRejection({
      repository,
      prNumber,
      prHeadRepository: 'someone-else/Crawler',
      run: {
        path: '.github/workflows/ci-recovery-router.yml',
        event: 'pull_request_review',
        pull_requests: [{ number: prNumber }],
      },
    }),
    'fork',
  );
});

test('rejects runs that do not list the target PR', () => {
  assert.equal(rejection({ pull_requests: [{ number: 99 }] }), 'pr-not-listed');
  assert.equal(rejection({ pull_requests: [] }), 'pr-not-listed');
});

test('rejects non-allowlisted workflow paths even when the display name is spoofed', () => {
  assert.equal(rejection({ path: '.github/workflows/other.yml' }), 'not-in-allowlist');
});

test('rejects off-diagonal workflow and event combinations', () => {
  assert.equal(rejection({ path: '.github/workflows/ci.yml' }), 'event=pull_request_review');
  assert.equal(rejection({ event: 'pull_request' }), 'event=pull_request');
  assert.equal(rejection({ event: 'issue_comment' }), 'event=issue_comment');
});

test('applies the same policy to rerun attempts', () => {
  assert.equal(rejection({ run_attempt: 2 }), null);
});
