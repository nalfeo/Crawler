import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowApprovalRejection, REQUIRED_CHECK_WORKFLOW_PATHS } from './approval.mjs';

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

test('skips same-repository CI Recovery Router runs as non-approvable', () => {
  assert.equal(rejection(), 'same-repository');
  assert.equal(rejection({ event: 'pull_request_review_comment' }), 'same-repository');
});

test('skips same-repository CI workflows only after validating pull-request events', () => {
  assert.equal(
    rejection({ path: '.github/workflows/ci.yml', event: 'pull_request' }),
    'same-repository',
  );
  // commit-lint was removed in PR #1109; its workflow path is no longer in the allowlist.
  assert.equal(
    rejection({ path: '.github/workflows/commit-lint.yml', event: 'pull_request_target' }),
    'not-in-allowlist',
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

test('rejects an allowlisted workflow when the PR modifies its definition', () => {
  assert.equal(
    workflowApprovalRejection({
      repository,
      prNumber,
      prHeadRepository: repository,
      changedFiles: [{ filename: '.github/workflows/ci-recovery-router.yml' }],
      run: {
        path: '.github/workflows/ci-recovery-router.yml',
        event: 'pull_request_review',
        pull_requests: [{ number: prNumber }],
      },
    }),
    'workflow-modified',
  );
});

test('rejects an allowlisted workflow when the PR renames its definition file', () => {
  assert.equal(
    workflowApprovalRejection({
      repository,
      prNumber,
      prHeadRepository: repository,
      changedFiles: [
        {
          filename: '.github/workflows/ci-recovery-router-v2.yml',
          previous_filename: '.github/workflows/ci-recovery-router.yml',
        },
      ],
      run: {
        path: '.github/workflows/ci-recovery-router.yml',
        event: 'pull_request_review',
        pull_requests: [{ number: prNumber }],
      },
    }),
    'workflow-modified',
  );
});

test('rejects when changed-files list is incomplete', () => {
  assert.equal(
    workflowApprovalRejection({
      repository,
      prNumber,
      prHeadRepository: repository,
      expectedChangedFiles: 4001,
      changedFiles: Array.from({ length: 3000 }, (_, index) => ({
        filename: `.github/workflows/workflow-${index}.yml`,
      })),
      run: {
        path: '.github/workflows/ci-recovery-router.yml',
        event: 'pull_request_review',
        pull_requests: [{ number: prNumber }],
      },
    }),
    'changed-files-incomplete',
  );
});

test('rejects off-diagonal workflow and event combinations', () => {
  assert.equal(rejection({ path: '.github/workflows/ci.yml' }), 'event=pull_request_review');
  assert.equal(rejection({ event: 'pull_request' }), 'event=pull_request');
  assert.equal(rejection({ event: 'issue_comment' }), 'event=issue_comment');
});

test('applies the same policy to rerun attempts', () => {
  assert.equal(rejection({ run_attempt: 2 }), 'same-repository');
});

test('REQUIRED_CHECK_WORKFLOW_PATHS contains exactly the admission-required CI check paths', () => {
  // This export is the source of truth used by reconcile.mjs to distinguish
  // required-check escalation blockers from non-required infrastructure runs.
  // commit-lint was removed in PR #1109; only ci.yml remains admission-required.
  assert.ok(
    REQUIRED_CHECK_WORKFLOW_PATHS instanceof Set,
    'REQUIRED_CHECK_WORKFLOW_PATHS must be a Set',
  );
  assert.ok(REQUIRED_CHECK_WORKFLOW_PATHS.has('.github/workflows/ci.yml'), 'must include ci.yml');
  assert.ok(
    !REQUIRED_CHECK_WORKFLOW_PATHS.has('.github/workflows/commit-lint.yml'),
    'must NOT include commit-lint.yml (removed in PR #1109)',
  );
  // The CI Recovery Router is a non-required infrastructure workflow and must
  // NOT be in this set (its action_required status is logged and skipped).
  assert.ok(
    !REQUIRED_CHECK_WORKFLOW_PATHS.has('.github/workflows/ci-recovery-router.yml'),
    'must NOT include ci-recovery-router.yml',
  );
  assert.equal(
    REQUIRED_CHECK_WORKFLOW_PATHS.size,
    1,
    'must contain exactly one entry (ci.yml)',
  );
});
