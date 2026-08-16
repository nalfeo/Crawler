import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HUMAN_APPROVAL_LABEL,
  HUMAN_APPROVAL_PHRASE,
  HUMAN_APPROVAL_PHRASE_VARIANT,
  closingIssuesPropagatingHumanApproval,
  hasOwnerApproval,
  humanApprovalRejection,
  requiresHumanApproval,
  stripClosingKeywordsForIssues,
} from './human-approval.mjs';

const gatedIssue = {
  number: 1190,
  labels: { nodes: [{ name: HUMAN_APPROVAL_LABEL }] },
};

test('detects the durable PR label, source-issue label, and nightly Copilot branch', () => {
  assert.equal(requiresHumanApproval({ labels: [{ name: HUMAN_APPROVAL_LABEL }] }), true);
  assert.equal(requiresHumanApproval({}, [gatedIssue]), true);
  // Legacy branch name ('driven' variant) — must still match
  assert.equal(
    requiresHumanApproval({
      head: { ref: 'copilot/balance-telemetry-driven-improvement-sweep' },
    }),
    true,
  );
  // Current branch name (no 'driven') — was the root cause of the stale-prefix defect
  assert.equal(
    requiresHumanApproval({
      head: { ref: 'copilot/balance-telemetry-improvement-sweep' },
    }),
    true,
  );
  assert.equal(requiresHumanApproval({ head: { ref: 'copilot/unrelated-fix' } }), false);
});

test('accepts only exact repository-owner approval comment variants', () => {
  assert.equal(
    hasOwnerApproval(
      [{ user: { login: 'nalfeo' }, body: `  ${HUMAN_APPROVAL_PHRASE}\n` }],
      'nalfeo',
    ),
    true,
  );
  assert.equal(
    hasOwnerApproval(
      [{ user: { login: 'nalfeo' }, body: HUMAN_APPROVAL_PHRASE_VARIANT }],
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

test('closingIssuesPropagatingHumanApproval returns propagating issues when PR has no direct gate', () => {
  const propagating = closingIssuesPropagatingHumanApproval({}, [gatedIssue]);
  assert.deepEqual(propagating, [gatedIssue]);

  // PR carries the label directly (automation-derived from a previous reconciler
  // run) — should still return propagating issues so the strip can proceed.
  assert.deepEqual(
    closingIssuesPropagatingHumanApproval({ labels: [{ name: HUMAN_APPROVAL_LABEL }] }, [
      gatedIssue,
    ]),
    [gatedIssue],
  );

  // PR is a nightly-balance branch — no auto-strip (intentional gate)
  assert.deepEqual(
    closingIssuesPropagatingHumanApproval(
      { head: { ref: 'copilot/balance-telemetry-improvement-sweep' } },
      [gatedIssue],
    ),
    [],
  );

  // No closing issues with the label — nothing to propagate
  const ungatedIssue = { number: 42, labels: { nodes: [{ name: 'bug' }] } };
  assert.deepEqual(closingIssuesPropagatingHumanApproval({}, [ungatedIssue]), []);

  // Empty closing issues
  assert.deepEqual(closingIssuesPropagatingHumanApproval({}, []), []);

  // PR has label directly AND no closing issues — label is intentional, nothing to propagate
  assert.deepEqual(
    closingIssuesPropagatingHumanApproval({ labels: [{ name: HUMAN_APPROVAL_LABEL }] }, []),
    [],
  );
});

test('stripClosingKeywordsForIssues removes closing-keyword lines for targeted issue numbers', () => {
  // Exact match for the PR #2687 scenario: "- Fixes #2686" is stripped, "Refs" line preserved.
  const body = 'Refs nalfeo/Crawler#2686\n\n- Fixes #2686';
  const result = stripClosingKeywordsForIssues(body, [2686]);
  assert.equal(result, 'Refs nalfeo/Crawler#2686\n');

  // All GitHub closing-keyword verb forms, case-insensitive
  const allVerbs = [
    'close #100',
    'closes #100',
    'closed #100',
    'fix #100',
    'fixes #100',
    'fixed #100',
    'resolve #100',
    'resolves #100',
    'resolved #100',
    '- Close #100',
    '- FIXES #100',
    '* Resolved #100',
  ];
  for (const line of allVerbs) {
    assert.equal(
      stripClosingKeywordsForIssues(line, [100]),
      '',
      `expected "${line}" to be stripped`,
    );
  }

  // Non-targeted issue number is preserved
  assert.equal(stripClosingKeywordsForIssues('- Fixes #2687', [2686]), '- Fixes #2687');

  // Non-closing "Refs" reference is never stripped
  assert.equal(stripClosingKeywordsForIssues('Refs #2686', [2686]), 'Refs #2686');

  // Lines with trailing prose are preserved (not a standalone closing ref)
  assert.equal(
    stripClosingKeywordsForIssues('Fixes #2686 and updates docs', [2686]),
    'Fixes #2686 and updates docs',
  );

  // owner/repo#N form is stripped when using plain-number target (legacy: any repo)
  assert.equal(stripClosingKeywordsForIssues('Fixes nalfeo/Crawler#2686', [2686]), '');

  // Empty issue list — body unchanged
  const original = 'Fixes #42\nOther line';
  assert.equal(stripClosingKeywordsForIssues(original, []), original);

  // Null/undefined body
  assert.equal(stripClosingKeywordsForIssues(null, [42]), '');
  assert.equal(stripClosingKeywordsForIssues(undefined, [42]), '');
});

test('stripClosingKeywordsForIssues preserves repository identity for {repository,number} targets', () => {
  // Qualified ref to a different repo with the same number must NOT be stripped
  const body = 'Fixes other/repo#42\nFixes nalfeo/Crawler#42';
  const result = stripClosingKeywordsForIssues(
    body,
    [{ repository: 'nalfeo/Crawler', number: 42 }],
    'nalfeo/Crawler',
  );
  assert.equal(result, 'Fixes other/repo#42');

  // Unqualified #N is treated as the current repository and stripped
  const bodyUnqualified = 'Fixes other/repo#42\nFixes #42';
  const resultUnqualified = stripClosingKeywordsForIssues(
    bodyUnqualified,
    [{ repository: 'nalfeo/Crawler', number: 42 }],
    'nalfeo/Crawler',
  );
  assert.equal(resultUnqualified, 'Fixes other/repo#42');

  // Qualified ref to the target repo IS stripped
  const bodyQualified = 'Fixes nalfeo/Crawler#42';
  assert.equal(
    stripClosingKeywordsForIssues(
      bodyQualified,
      [{ repository: 'nalfeo/Crawler', number: 42 }],
      'nalfeo/Crawler',
    ),
    '',
  );

  // Unqualified #N is NOT stripped when currentRepo does not match the target repo
  const bodyOtherRepo = 'Fixes #42';
  assert.equal(
    stripClosingKeywordsForIssues(
      bodyOtherRepo,
      [{ repository: 'other/repo', number: 42 }],
      'nalfeo/Crawler',
    ),
    'Fixes #42',
  );

  // Repository matching is case-insensitive
  assert.equal(
    stripClosingKeywordsForIssues(
      'Fixes NALFEO/CRAWLER#2686',
      [{ repository: 'nalfeo/Crawler', number: 2686 }],
      'nalfeo/Crawler',
    ),
    '',
  );
});
