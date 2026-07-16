import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HUMAN_APPROVAL_LABEL,
  HUMAN_APPROVAL_PHRASE,
  hasOwnerApproval,
  humanApprovalRejection,
  requiresHumanApproval,
} from './human-approval.mjs';

const gatedIssue = {
  number: 1190,
  labels: { nodes: [{ name: HUMAN_APPROVAL_LABEL }] },
};

test('detects the durable PR label, source-issue label, and nightly Copilot branch', () => {
  assert.equal(requiresHumanApproval({ labels: [{ name: HUMAN_APPROVAL_LABEL }] }), true);
  assert.equal(requiresHumanApproval({}, [gatedIssue]), true);
  assert.equal(
    requiresHumanApproval({
      head: { ref: 'copilot/balance-telemetry-driven-improvement-sweep' },
    }),
    true,
  );
  assert.equal(requiresHumanApproval({ head: { ref: 'copilot/unrelated-fix' } }), false);
});

test('accepts only the exact repository-owner approval comment', () => {
  assert.equal(
    hasOwnerApproval(
      [{ user: { login: 'nalfeo' }, body: `  ${HUMAN_APPROVAL_PHRASE}\n` }],
      'nalfeo',
    ),
    true,
  );
  assert.equal(
    hasOwnerApproval([{ user: { login: 'other-user' }, body: HUMAN_APPROVAL_PHRASE }], 'nalfeo'),
    false,
  );
  assert.equal(
    hasOwnerApproval(
      [{ user: { login: 'nalfeo' }, body: `Looks good: ${HUMAN_APPROVAL_PHRASE}` }],
      'nalfeo',
    ),
    false,
  );
  assert.equal(
    hasOwnerApproval([{ user: { login: 'nalfeo' }, body: `> ${HUMAN_APPROVAL_PHRASE}` }], 'nalfeo'),
    false,
  );
});

test('rejects gated PRs until the exact owner approval exists', () => {
  const pullRequest = { labels: [{ name: HUMAN_APPROVAL_LABEL }] };
  assert.match(
    humanApprovalRejection({
      pullRequest,
      closingIssues: [],
      comments: [],
      ownerLogin: 'nalfeo',
    }),
    /waiting for nalfeo/,
  );
  assert.equal(
    humanApprovalRejection({
      pullRequest,
      closingIssues: [],
      comments: [{ user: { login: 'nalfeo' }, body: HUMAN_APPROVAL_PHRASE }],
      ownerLogin: 'nalfeo',
    }),
    null,
  );
});
