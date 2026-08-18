import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  HUMAN_APPROVAL_LABEL,
  HUMAN_APPROVAL_PHRASE,
  HUMAN_APPROVAL_PHRASE_VARIANT,
  closingIssuesPropagatingHumanApproval,
  hasHumanApproval,
  hasOwnerApproval,
  hasOwnerApprovalReview,
  humanApprovalRejection,
  requiresHumanApproval,
  resolveHumanApprovalRejection,
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

test('accepts a real approving review from the repository owner', () => {
  assert.equal(
    hasOwnerApprovalReview([{ user: { login: 'nalfeo' }, state: 'APPROVED' }], 'nalfeo'),
    true,
  );
  // Lowercase state (GraphQL/webhook payloads) still counts.
  assert.equal(
    hasOwnerApprovalReview([{ user: { login: 'NALFEO' }, state: 'approved' }], 'nalfeo'),
    true,
  );
  assert.equal(
    hasOwnerApprovalReview([{ user: { login: 'other-user' }, state: 'APPROVED' }], 'nalfeo'),
    false,
  );
  assert.equal(
    hasOwnerApprovalReview([{ user: { login: 'nalfeo' }, state: 'COMMENTED' }], 'nalfeo'),
    false,
  );
  assert.equal(hasOwnerApprovalReview([], 'nalfeo'), false);
  assert.equal(hasOwnerApprovalReview(undefined, 'nalfeo'), false);
});

test('only the owner latest decisive review counts', () => {
  const approved = {
    user: { login: 'nalfeo' },
    state: 'APPROVED',
    submitted_at: '2026-08-16T01:00:00Z',
  };
  const changesRequested = {
    user: { login: 'nalfeo' },
    state: 'CHANGES_REQUESTED',
    submitted_at: '2026-08-16T02:00:00Z',
  };
  const dismissed = {
    user: { login: 'nalfeo' },
    state: 'DISMISSED',
    submitted_at: '2026-08-16T02:00:00Z',
  };
  const commented = {
    user: { login: 'nalfeo' },
    state: 'COMMENTED',
    submitted_at: '2026-08-16T03:00:00Z',
  };
  assert.equal(hasOwnerApprovalReview([approved, changesRequested], 'nalfeo'), false);
  assert.equal(hasOwnerApprovalReview([approved, dismissed], 'nalfeo'), false);
  const reApproved = {
    user: { login: 'nalfeo' },
    state: 'APPROVED',
    submitted_at: '2026-08-16T03:00:00Z',
  };
  assert.equal(hasOwnerApprovalReview([changesRequested, reApproved], 'nalfeo'), true);
  // A later non-decisive review never revokes an existing approval.
  assert.equal(hasOwnerApprovalReview([approved, commented], 'nalfeo'), true);
  // Without timestamps, array order is the tiebreak.
  assert.equal(
    hasOwnerApprovalReview(
      [
        { user: { login: 'nalfeo' }, state: 'CHANGES_REQUESTED' },
        { user: { login: 'nalfeo' }, state: 'APPROVED' },
      ],
      'nalfeo',
    ),
    true,
  );
});

test('hasHumanApproval accepts either an approving review or the exact comment', () => {
  assert.equal(
    hasHumanApproval({
      comments: [],
      reviews: [{ user: { login: 'nalfeo' }, state: 'APPROVED' }],
      ownerLogin: 'nalfeo',
    }),
    true,
  );
  assert.equal(
    hasHumanApproval({
      comments: [{ user: { login: 'nalfeo' }, body: HUMAN_APPROVAL_PHRASE }],
      reviews: [],
      ownerLogin: 'nalfeo',
    }),
    true,
  );
  assert.equal(
    hasHumanApproval({
      comments: [{ user: { login: 'nalfeo' }, body: 'lgtm' }],
      reviews: [{ user: { login: 'nalfeo' }, state: 'COMMENTED' }],
      ownerLogin: 'nalfeo',
    }),
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
  // A real approving review from the owner satisfies the gate.
  assert.equal(
    humanApprovalRejection({
      pullRequest,
      closingIssues: [],
      comments: [],
      reviews: [{ user: { login: 'nalfeo' }, state: 'APPROVED' }],
      ownerLogin: 'nalfeo',
    }),
    null,
  );
  // A revoked approval re-blocks the PR.
  assert.match(
    humanApprovalRejection({
      pullRequest,
      closingIssues: [],
      comments: [],
      reviews: [
        { user: { login: 'nalfeo' }, state: 'APPROVED', submitted_at: '2026-08-16T01:00:00Z' },
        {
          user: { login: 'nalfeo' },
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-08-16T02:00:00Z',
        },
      ],
      ownerLogin: 'nalfeo',
    }),
    /waiting for nalfeo/,
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

test('resolveHumanApprovalRejection fetches reviews only when the gate applies', async () => {
  const gatedPr = { labels: [{ name: HUMAN_APPROVAL_LABEL }] };
  let fetches = 0;
  const fetchReviews = async () => {
    fetches += 1;
    return [{ user: { login: 'nalfeo' }, state: 'APPROVED' }];
  };

  // Ungated PR: never pays for the reviews request.
  assert.equal(
    await resolveHumanApprovalRejection({
      pullRequest: {},
      closingIssues: [],
      comments: [],
      ownerLogin: 'nalfeo',
      fetchReviews,
    }),
    null,
  );
  assert.equal(fetches, 0);

  // Gated PR with an approving owner review: unblocked.
  assert.equal(
    await resolveHumanApprovalRejection({
      pullRequest: gatedPr,
      closingIssues: [],
      comments: [],
      ownerLogin: 'nalfeo',
      fetchReviews,
    }),
    null,
  );
  assert.equal(fetches, 1);

  // Gated PR already unblocked by the exact comment: short-circuits the fetch.
  assert.equal(
    await resolveHumanApprovalRejection({
      pullRequest: gatedPr,
      closingIssues: [],
      comments: [{ user: { login: 'nalfeo' }, body: HUMAN_APPROVAL_PHRASE }],
      ownerLogin: 'nalfeo',
      fetchReviews,
    }),
    null,
  );
  assert.equal(fetches, 1);

  // Gated PR with no approval at all: still blocked.
  assert.match(
    await resolveHumanApprovalRejection({
      pullRequest: gatedPr,
      closingIssues: [],
      comments: [],
      ownerLogin: 'nalfeo',
      fetchReviews: async () => [{ user: { login: 'nalfeo' }, state: 'COMMENTED' }],
    }),
    /waiting for nalfeo/,
  );
});

// Wiring proof: every human-approval gate call site must go through the
// review-aware resolver, or a real owner review would be ignored by that path.
test('all human-approval gate call sites use the review-aware resolver', () => {
  const callSites = [
    './human-approval-check.mjs',
    './reconcile.mjs',
    './ci-conflict-order.mjs',
    '../ci-recovery/reconcile.mjs',
    '../ci-conflict-coordinator/reconcile.mjs',
  ];
  for (const relative of callSites) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    assert.ok(
      source.includes('resolveHumanApprovalRejection'),
      `${relative} must call resolveHumanApprovalRejection`,
    );
    assert.ok(
      !/\bhumanApprovalRejection\(/.test(source.replace(/resolveHumanApprovalRejection/g, '')),
      `${relative} must not call the review-blind humanApprovalRejection directly`,
    );
  }
});
