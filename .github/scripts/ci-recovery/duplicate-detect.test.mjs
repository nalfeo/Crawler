import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectDuplicateProof,
  detectQuarantineEvidence,
  PROOF_RULES,
  proveEmptyDiff,
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

test('golden fixture #1630/#1575/#1568: shared-issue sibling is quarantine evidence, not auto-close proof', () => {
  const proof = detectDuplicateProof(
    { number: 1630, additions: 300, deletions: 10 },
    {
      closingIssues: [{ number: 1568, state: 'CLOSED' }],
      mergedSiblings: [{ number: 1575, merged: true, closingIssueNumbers: [1568] }],
    },
  );

  assert.equal(proof.proofRule, null, 'shared linked issue is not deterministic auto-close proof');
  assert.equal(proof.supersederPr, null);
  assert.equal(proof.reason, null);
});

test('golden fixture #1630: quarantine evidence cites PR #1575 for human KEEP/ABANDON decision', () => {
  const evidence = detectQuarantineEvidence(
    { number: 1630 },
    {
      closingIssues: [{ number: 1568, state: 'CLOSED' }],
      mergedSiblings: [{ number: 1575, merged: true, closingIssueNumbers: [1568] }],
    },
  );
  assert.equal(evidence.evidenceRule, PROOF_RULES.SIBLING_MERGED);
  assert.equal(evidence.supersederPr, 1575);
});

// ---------------------------------------------------------------------------
// Rule 1: sibling-merged (quarantine evidence)
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
// Rule 2: empty-diff
// ---------------------------------------------------------------------------

test('Rule 2: fires when additions=0 and deletions=0', () => {
  const result = proveEmptyDiff({ additions: 0, deletions: 0 });
  assert.equal(result.proved, true);
  assert.ok(result.reason);
});

test('Rule 2: does NOT fire when additions>0', () => {
  assert.equal(proveEmptyDiff({ additions: 1, deletions: 0 }).proved, false);
  assert.equal(proveEmptyDiff({ additions: 0, deletions: 1 }).proved, false);
  assert.equal(proveEmptyDiff({ additions: 5, deletions: 5 }).proved, false);
});

test('Rule 2: does NOT fire when diff size unknown (absent or negative)', () => {
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

test('issue overlap with merged sibling is not auto-close proof (routes to quarantine)', () => {
  const proof = detectDuplicateProof(
    { number: 42, additions: 10, deletions: 0 },
    {
      closingIssues: [{ number: 100, state: 'CLOSED' }],
      mergedSiblings: [{ number: 77, merged: true, closingIssueNumbers: [100] }],
    },
  );
  assert.equal(proof.proofRule, null);
  assert.equal(proof.supersederPr, null);
});

test('Rule 2 fires when diff is zero, even without closing issues', () => {
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
