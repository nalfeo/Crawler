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

test('skips same-repository CI Recovery Router runs as non-approvable', () => {
  assert.equal(rejection(), 'same-repository');
  assert.equal(rejection({ event: 'pull_request_review_comment' }), 'same-repository');
});

test('skips same-repository CI workflows only after validating pull-request events', () => {
  assert.equal(
    rejection({ path: '.github/workflows/ci.yml', event: 'pull_request' }),
    'same-repository',
  );
  assert.equal(
    rejection({ path: '.github/workflows/commit-lint.yml', event: 'pull_request_target' }),
    'same-repository',
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
