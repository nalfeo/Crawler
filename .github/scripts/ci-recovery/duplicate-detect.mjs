/**
 * duplicate-detect.mjs — Deterministic duplicate / superfluous PR detection.
 *
 * Pure module: no side effects, no async, no GitHub API calls.  The caller is
 * responsible for fetching and supplying all required facts.
 *
 * Implements deterministic auto-close proof rules. Auto-close happens ONLY when
 * one of these rules returns a non-null proof. Any uncertainty routes to
 * quarantine, never to a close (conservatism invariant).
 *
 * Auto-close proof rules (deterministic):
 *   1. EMPTY_DIFF — PR diff is zero (all changes already on main)
 *
 * Quarantine-evidence helper (not a proof — routes to quarantine, not close):
 *   SIBLING_MERGED — merged sibling closes same issue (issue may still be open).
 *   Two PRs can legitimately reference the same issue (feature + tests, etc.);
 *   shared issue alone is not deterministic proof of redundancy.
 *   Use detectQuarantineEvidence() when scanning for suspicious PRs.
 *
 * Design source:
 *   docs/knowledge/ci-recovery/2026-07-20-harness-holistic-review.md §7
 *   GitHub issue #1892 (CI-harness redesign, Issue 8)
 *
 * Golden incident fixture: PR #1630 / PR #1575 / issue #1568.
 *   Shared closing issue + merged sibling is quarantine evidence, not an
 *   auto-close proof.
 */

/** Canonical proof-rule identifiers. */
export const PROOF_RULES = {
  /**
   * A sibling PR — sharing one or more closing issues — has MERGED, even if
   * the shared issue is not yet CLOSED.
   * Covers: "sibling PR with same closing issue has merged".
   * → Quarantine evidence only (NOT a proof for auto-close).
   *   Two PRs can legitimately reference the same issue; use detectQuarantineEvidence()
   *   to surface this suspicion, never detectDuplicateProof().
   */
  SIBLING_MERGED: 'sibling-merged',

  /**
   * The PR's diff against its base is empty: additions + deletions = 0.
   * All of this PR's changes are already on `main`.
   * Covers: "PR is a full no-op relative to base".
   * → Auto-close proof.
   */
  EMPTY_DIFF: 'empty-diff',
};

/**
 * Try proof rule SIBLING_MERGED:
 *   - A different merged sibling PR closes one or more of the same issues as
 *     this PR, regardless of whether the shared issue is CLOSED yet.
 *
 * @param {number} prNumber
 * @param {number[]} ownClosingIssueNumbers
 * @param {{ number: number, merged: boolean, closingIssueNumbers: number[] }[]} mergedSiblings
 * @returns {{ proved: boolean, supersederPr: number|null, reason: string|null }}
 */
export function proveSiblingMerged(prNumber, ownClosingIssueNumbers, mergedSiblings) {
  if ((ownClosingIssueNumbers || []).length === 0) {
    return { proved: false, supersederPr: null, reason: null };
  }
  const ownSet = new Set((ownClosingIssueNumbers || []).map(Number));

  for (const sibling of mergedSiblings || []) {
    if (!sibling.merged || Number(sibling.number) === Number(prNumber)) continue;
    for (const issueNum of sibling.closingIssueNumbers || []) {
      if (ownSet.has(Number(issueNum))) {
        return {
          proved: true,
          supersederPr: Number(sibling.number),
          reason: `sibling-pr-#${sibling.number}-merged-closing-issue-#${issueNum}`,
        };
      }
    }
  }
  return { proved: false, supersederPr: null, reason: null };
}

/**
 * Try proof rule EMPTY_DIFF:
 *   - The PR's diff against its base is zero: additions + deletions = 0.
 *
 * @param {{ additions: number, deletions: number }} pr
 * @returns {{ proved: boolean, reason: string|null }}
 */
export function proveEmptyDiff(pr) {
  const additions = Number(pr?.additions ?? -1);
  const deletions = Number(pr?.deletions ?? -1);
  if (additions < 0 || deletions < 0) {
    // Unknown diff size — conservatively cannot prove
    return { proved: false, reason: null };
  }
  if (additions === 0 && deletions === 0) {
    return { proved: true, reason: 'zero-additions-zero-deletions' };
  }
  return { proved: false, reason: null };
}

/**
 * Run all AUTO-CLOSE proof rules in priority order and return the first
 * successful proof. Only EMPTY_DIFF is an auto-close proof; SIBLING_MERGED is
 * quarantine evidence only (see detectQuarantineEvidence).
 *
 * Conservatism invariant: returns `{ proofRule: null }` — never auto-closes —
 * unless one of the deterministic proof rules succeeds.  The caller MUST route
 * an unproved PR to quarantine, not to auto-close.
 *
 * @param {{ number: number, additions?: number, deletions?: number }} pr
 * @param {{
 *   closingIssues?: { number: number, state: string }[];
 *   mergedSiblings?: { number: number, merged: boolean, closingIssueNumbers: number[] }[];
 * }} context
 * @returns {{
 *   proofRule: string|null,
 *   supersederPr: number|null,
 *   reason: string|null
 * }}
 */
export function detectDuplicateProof(pr, context = {}) {
  const prNumber = Number(pr?.number);
  void context;

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { proofRule: null, supersederPr: null, reason: null };
  }

  // SIBLING_MERGED is quarantine evidence only — NOT an auto-close proof.
  // Two PRs can legitimately reference the same issue (feature + tests, etc.);
  // "sibling merged + same issue" alone is not deterministic proof of redundancy.
  // The caller must use detectQuarantineEvidence() for suspicion-based quarantine.

  // Rule 1: empty-diff (all changes already on main)
  const r1 = proveEmptyDiff(pr);
  if (r1.proved) {
    return {
      proofRule: PROOF_RULES.EMPTY_DIFF,
      supersederPr: null,
      reason: r1.reason,
    };
  }

  // No deterministic proof — caller must route to quarantine, not auto-close.
  return { proofRule: null, supersederPr: null, reason: null };
}

/**
 * Detect quarantine-worthy suspicion (NOT a proof for auto-close).
 *
 * Returns SIBLING_MERGED evidence when a merged sibling closes the same issue
 * as this PR, even if the issue is still OPEN.  This is suspicious but not
 * deterministic proof of redundancy — the caller must route to quarantine, never
 * to auto-close.
 *
 * Returns `{ evidenceRule: null }` when no suspicion is found.
 *
 * @param {{ number: number }} pr
 * @param {{
 *   closingIssues?: { number: number, state: string }[];
 *   mergedSiblings?: { number: number, merged: boolean, closingIssueNumbers: number[] }[];
 * }} context
 * @returns {{
 *   evidenceRule: string|null,
 *   supersederPr: number|null,
 *   reason: string|null
 * }}
 */
export function detectQuarantineEvidence(pr, context = {}) {
  const prNumber = Number(pr?.number);
  const closingIssues = context.closingIssues || [];
  const mergedSiblings = context.mergedSiblings || [];

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { evidenceRule: null, supersederPr: null, reason: null };
  }

  const ownIssueNumbers = (closingIssues || []).map((i) => Number(i.number));
  const r2 = proveSiblingMerged(prNumber, ownIssueNumbers, mergedSiblings);
  if (r2.proved) {
    return {
      evidenceRule: PROOF_RULES.SIBLING_MERGED,
      supersederPr: r2.supersederPr,
      reason: r2.reason,
    };
  }

  return { evidenceRule: null, supersederPr: null, reason: null };
}
