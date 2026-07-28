import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectDuplicateProof,
  detectQuarantineEvidence,
  PROOF_RULES,
  proveEmptyDiff,
  proveLinkedIssueSiblingClosed,
  proveSiblingMerged,
} from './duplicate-detect.mjs';

// ---------------------------------------------------------------------------
// Golden fixture: PR #1630 / PR #1575 / issue #1568
//
// Incident 2026-07-24: PR #1630 re-implemented "deterministic AI equipment
// loadout scoring", a feature already merged via PR #1575 (which closed issue
// #1568). PR #1630 also linked issue #1568, sat dirty+red for ~2 days as the
// CLUSTER LEADER of ci-conflict-37c837105d3694df, and dead-headed PRs #1782
// and #1861 (the epic's own critical path). A human had to close it manually.
// This detection must make that class structurally impossible.
// ---------------------------------------------------------------------------

test('golden fixture #1630/#1575/#1568: sibling-merged proof fires, cites PR #1575', () => {
  const proof = detectDuplicateProof(
    { number: 1630, additions: 300, deletions: 10 },
    {
      closingIssues: [{ number: 1568, state: 'CLOSED' }],
      mergedSiblings: [{ number: 1575, merged: true, closingIssueNumbers: [1568] }],
    },
  );

  assert.equal(proof.proofRule, PROOF_RULES.LINKED_ISSUE_SIBLING, 'rule 1 fires first (closed issue + merged sibling)');
  assert.equal(proof.supersederPr, 1575, 'superseder is PR #1575');
  assert.ok(proof.reason, 'reason is populated');
  assert.ok(String(proof.reason).includes('1575'), 'reason cites PR #1575');
  assert.ok(String(proof.reason).includes('1568'), 'reason cites issue #1568');
});

test('golden fixture #1630: re-running detection closes the duplicate and cites PR #1575', () => {
  // Acceptance criterion: "Re-running detection against the #1630/#1575/#1568
  // fact-pattern closes the duplicate and cites the superseding PR #1575."
  const proof = detectDuplicateProof(
    { number: 1630 },
    {
      closingIssues: [{ number: 1568, state: 'CLOSED' }],
      mergedSiblings: [{ number: 1575, merged: true, closingIssueNumbers: [1568] }],
    },
  );
  assert.ok(proof.proofRule !== null, 'proof rule fires (auto-close warranted)');
  assert.equal(proof.supersederPr, 1575);
});

// ---------------------------------------------------------------------------
// Rule 1: linked-issue-closed-by-sibling
// ---------------------------------------------------------------------------

test('Rule 1: fires when closing issue is CLOSED and merged sibling closes same issue', () => {
  const result = proveLinkedIssueSiblingClosed(
    42,
    [{ number: 100, state: 'CLOSED' }],
    [{ number: 77, merged: true, closingIssueNumbers: [100] }],
  );
  assert.equal(result.proved, true);
  assert.equal(result.supersederPr, 77);
  assert.ok(String(result.reason).includes('77'));
  assert.ok(String(result.reason).includes('100'));
});

test('Rule 1: does NOT fire when closing issue is OPEN (even if sibling merged)', () => {
  const result = proveLinkedIssueSiblingClosed(
    42,
    [{ number: 100, state: 'OPEN' }],
    [{ number: 77, merged: true, closingIssueNumbers: [100] }],
  );
  assert.equal(result.proved, false);
});

test('Rule 1: does NOT fire when closing issue is CLOSED but no merged sibling shares it', () => {
  const result = proveLinkedIssueSiblingClosed(
    42,
    [{ number: 100, state: 'CLOSED' }],
    [{ number: 77, merged: true, closingIssueNumbers: [999] }], // different issue
  );
  assert.equal(result.proved, false);
});

test('Rule 1: does NOT fire when only sibling is the same PR', () => {
  const result = proveLinkedIssueSiblingClosed(
    77,
    [{ number: 100, state: 'CLOSED' }],
    [{ number: 77, merged: true, closingIssueNumbers: [100] }], // same number
  );
  assert.equal(result.proved, false);
});

test('Rule 1: does NOT fire when sibling is not merged (still open)', () => {
  const result = proveLinkedIssueSiblingClosed(
    42,
    [{ number: 100, state: 'CLOSED' }],
    [{ number: 77, merged: false, closingIssueNumbers: [100] }],
  );
  assert.equal(result.proved, false);
});

test('Rule 1: case-insensitive state matching (lowercase "closed")', () => {
  const result = proveLinkedIssueSiblingClosed(
    42,
    [{ number: 100, state: 'closed' }],
    [{ number: 77, merged: true, closingIssueNumbers: [100] }],
  );
  assert.equal(result.proved, true);
});

// ---------------------------------------------------------------------------
// Rule 2: sibling-merged
// ---------------------------------------------------------------------------

test('Rule 2: fires when merged sibling closes same issue (issue still open)', () => {
  const result = proveSiblingMerged(
    42,
    [100],
    [{ number: 77, merged: true, closingIssueNumbers: [100] }],
  );
  assert.equal(result.proved, true);
  assert.equal(result.supersederPr, 77);
  assert.ok(String(result.reason).includes('77'));
  assert.ok(String(result.reason).includes('100'));
});

test('Rule 2: does NOT fire when PR closes no issues', () => {
  const result = proveSiblingMerged(42, [], [{ number: 77, merged: true, closingIssueNumbers: [100] }]);
  assert.equal(result.proved, false);
});

test('Rule 2: does NOT fire when no sibling merged', () => {
  const result = proveSiblingMerged(
    42,
    [100],
    [{ number: 77, merged: false, closingIssueNumbers: [100] }],
  );
  assert.equal(result.proved, false);
});

test('Rule 2: does NOT fire when sibling has no overlapping issues', () => {
  const result = proveSiblingMerged(42, [100], [{ number: 77, merged: true, closingIssueNumbers: [200] }]);
  assert.equal(result.proved, false);
});

test('Rule 2: fires with multiple closing issues — first overlap wins', () => {
  const result = proveSiblingMerged(
    42,
    [100, 101, 102],
    [{ number: 77, merged: true, closingIssueNumbers: [101] }],
  );
  assert.equal(result.proved, true);
  assert.equal(result.supersederPr, 77);
});

// ---------------------------------------------------------------------------
// Rule 3: empty-diff
// ---------------------------------------------------------------------------

test('Rule 3: fires when additions=0 and deletions=0', () => {
  const result = proveEmptyDiff({ additions: 0, deletions: 0 });
  assert.equal(result.proved, true);
  assert.ok(result.reason);
});

test('Rule 3: does NOT fire when additions>0', () => {
  assert.equal(proveEmptyDiff({ additions: 1, deletions: 0 }).proved, false);
  assert.equal(proveEmptyDiff({ additions: 0, deletions: 1 }).proved, false);
  assert.equal(proveEmptyDiff({ additions: 5, deletions: 5 }).proved, false);
});

test('Rule 3: does NOT fire when diff size unknown (absent or negative)', () => {
  assert.equal(proveEmptyDiff({}).proved, false);
  assert.equal(proveEmptyDiff({ additions: -1, deletions: 0 }).proved, false);
  assert.equal(proveEmptyDiff(null).proved, false);
});

// ---------------------------------------------------------------------------
// detectDuplicateProof — integration / conservatism
// ---------------------------------------------------------------------------

test('non-provable case: no closing issues, no siblings, non-zero diff → null (routes to quarantine)', () => {
  const proof = detectDuplicateProof(
    { number: 42, additions: 10, deletions: 5 },
    { closingIssues: [], mergedSiblings: [] },
  );
  // Conservatism invariant: uncertainty → null, never auto-close.
  assert.equal(proof.proofRule, null);
  assert.equal(proof.supersederPr, null);
  assert.equal(proof.reason, null);
});

test('non-provable case: stale/closed issue but NO merged sibling → null (routes to quarantine)', () => {
  // A PR that closes a CLOSED issue but has no merged sibling that also closes
  // it is NOT provably redundant — the issue may have been closed manually.
  const proof = detectDuplicateProof(
    { number: 42, additions: 30, deletions: 0 },
    {
      closingIssues: [{ number: 100, state: 'CLOSED' }],
      mergedSiblings: [], // no sibling closed this issue
    },
  );
  assert.equal(proof.proofRule, null, 'closed issue alone is insufficient proof');
});

test('non-provable case: open issue with merged sibling that closes a DIFFERENT issue → null', () => {
  const proof = detectDuplicateProof(
    { number: 42, additions: 20, deletions: 0 },
    {
      closingIssues: [{ number: 100, state: 'OPEN' }],
      mergedSiblings: [{ number: 77, merged: true, closingIssueNumbers: [200] }], // no overlap
    },
  );
  assert.equal(proof.proofRule, null, 'no overlapping issue → not a provable duplicate');
});

test('rule priority: Rule 1 fires when issue is CLOSED + sibling merged (Rule 2 is quarantine-only)', () => {
  // Both LINKED_ISSUE_SIBLING and SIBLING_MERGED conditions apply, but Rule 1 is the
  // deterministic auto-close proof; Rule 2 (SIBLING_MERGED) is quarantine evidence only.
  const proof = detectDuplicateProof(
    { number: 42, additions: 10, deletions: 0 },
    {
      closingIssues: [{ number: 100, state: 'CLOSED' }],
      mergedSiblings: [{ number: 77, merged: true, closingIssueNumbers: [100] }],
    },
  );
  assert.equal(proof.proofRule, PROOF_RULES.LINKED_ISSUE_SIBLING, 'Rule 1 fires (deterministic proof)');
});

test('Rule 3 fires when diff is zero, even without closing issues', () => {
  const proof = detectDuplicateProof(
    { number: 42, additions: 0, deletions: 0 },
    { closingIssues: [], mergedSiblings: [] },
  );
  assert.equal(proof.proofRule, PROOF_RULES.EMPTY_DIFF);
  assert.equal(proof.supersederPr, null);
});

test('invalid prNumber returns null without throwing', () => {
  assert.doesNotThrow(() => detectDuplicateProof({ number: -1 }));
  assert.doesNotThrow(() => detectDuplicateProof({ number: 0 }));
  assert.doesNotThrow(() => detectDuplicateProof(null));
  assert.equal(detectDuplicateProof(null).proofRule, null);
});

// ---------------------------------------------------------------------------
// SIBLING_MERGED demotion: NOT an auto-close proof
// ---------------------------------------------------------------------------

test('SIBLING_MERGED (open issue + merged sibling overlap) does NOT trigger auto-close', () => {
  // Rule 2 was demoted: sibling-merged is quarantine evidence, not an auto-close proof.
  // Even with a merged sibling closing the same open issue, detectDuplicateProof must
  // return null — two PRs can legitimately close the same issue (feature + tests, etc.).
  const proof = detectDuplicateProof(
    { number: 42, additions: 10, deletions: 0 },
    {
      closingIssues: [{ number: 100, state: 'OPEN' }],
      mergedSiblings: [{ number: 77, merged: true, closingIssueNumbers: [100] }],
    },
  );
  assert.equal(proof.proofRule, null, 'SIBLING_MERGED (issue still open) does not auto-close');
  assert.equal(proof.supersederPr, null);
});

// ---------------------------------------------------------------------------
// detectQuarantineEvidence — SIBLING_MERGED suspicion
// ---------------------------------------------------------------------------

test('detectQuarantineEvidence: returns SIBLING_MERGED when merged sibling closes same issue', () => {
  const evidence = detectQuarantineEvidence(
    { number: 42 },
    {
      closingIssues: [{ number: 100, state: 'OPEN' }],
      mergedSiblings: [{ number: 77, merged: true, closingIssueNumbers: [100] }],
    },
  );
  assert.equal(evidence.evidenceRule, PROOF_RULES.SIBLING_MERGED);
  assert.equal(evidence.supersederPr, 77);
  assert.ok(String(evidence.reason).includes('77'));
});

test('detectQuarantineEvidence: returns null when no sibling overlap', () => {
  const evidence = detectQuarantineEvidence(
    { number: 42 },
    {
      closingIssues: [{ number: 100, state: 'OPEN' }],
      mergedSiblings: [{ number: 77, merged: true, closingIssueNumbers: [999] }],
    },
  );
  assert.equal(evidence.evidenceRule, null);
});

test('detectQuarantineEvidence: returns null for invalid prNumber', () => {
  const evidence = detectQuarantineEvidence({ number: 0 }, {});
  assert.equal(evidence.evidenceRule, null);
  assert.doesNotThrow(() => detectQuarantineEvidence(null, {}));
});
