/**
 * duplicate-detect.mjs — Deterministic duplicate / superfluous PR detection.
 *
 * Pure module: no side effects, no async, no GitHub API calls.  The caller is
 * responsible for fetching and supplying all required facts.
 *
 * Implements three proof rules for auto-close.  Auto-close happens ONLY when
 * a rule returns a non-null proof.  Any uncertainty routes to quarantine, never
 * to a close (conservatism invariant).
 *
 * Design source:
 *   docs/knowledge/ci-recovery/2026-07-20-harness-holistic-review.md §7
 *   GitHub issue #1892 (CI-harness redesign, Issue 8)
 *
 * Golden incident fixture: PR #1630 / PR #1575 / issue #1568.
 *   PR #1630 (WIP re-implementation) closes issue #1568.
 *   PR #1575 merged earlier, also closing issue #1568.
 *   detectDuplicateProof({prNumber:1630}, {mergedSiblings:[{number:1575,closingIssueNumbers:[1568]}]})
 *   → { proofRule: 'sibling-merged', supersederPr: 1575, reason: 'sibling-pr-#1575-merged-closing-issue-#1568' }
 */

/** Canonical proof-rule identifiers. */
export const PROOF_RULES = {
  /**
   * A closing issue of this PR is CLOSED, and a different merged PR closes the
   * same issue (making it the effective superseder of this PR's intent).
   * Covers: "linked issue closed by sibling merged PR".
   */
  LINKED_ISSUE_SIBLING: 'linked-issue-closed-by-sibling',

  /**
   * A sibling PR — sharing one or more closing issues — has MERGED, even if
   * the shared issue is not yet CLOSED (e.g. issue still open but sibling landed).
   * Covers: "sibling PR with same closing issue has merged".
   */
  SIBLING_MERGED: 'sibling-merged',

  /**
   * The PR's diff against its base is empty: additions + deletions = 0.
   * All of this PR's changes are already on `main`.
   * Covers: "PR is a full no-op relative to base".
   */
  EMPTY_DIFF: 'empty-diff',
};

/**
 * Try proof rule LINKED_ISSUE_SIBLING:
 *   - One of the PR's closing issues is state=CLOSED (or stateReason=completed).
 *   - A different merged sibling PR closes the same issue.
 *
 * @param {number} prNumber
 * @param {{ number: number, state: string }[]} closingIssues
 * @param {{ number: number, merged: boolean, closingIssueNumbers: number[] }[]} mergedSiblings
 * @returns {{ proved: boolean, supersederPr: number|null, reason: string|null }}
 */
export function proveLinkedIssueSiblingClosed(prNumber, closingIssues, mergedSiblings) {
  const closedIssueNumbers = new Set(
    (closingIssues || [])
      .filter((issue) => String(issue?.state ?? '').toUpperCase() === 'CLOSED')
      .map((issue) => Number(issue.number)),
  );
  if (closedIssueNumbers.size === 0) {
    return { proved: false, supersederPr: null, reason: null };
  }

  for (const sibling of mergedSiblings || []) {
    if (!sibling.merged || Number(sibling.number) === Number(prNumber)) continue;
    for (const issueNum of sibling.closingIssueNumbers || []) {
      if (closedIssueNumbers.has(Number(issueNum))) {
        return {
          proved: true,
          supersederPr: Number(sibling.number),
          reason: `sibling-pr-#${sibling.number}-merged-closing-closed-issue-#${issueNum}`,
        };
      }
    }
  }
  return { proved: false, supersederPr: null, reason: null };
}

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
 * Run all proof rules in priority order and return the first successful proof.
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
  const closingIssues = context.closingIssues || [];
  const mergedSiblings = context.mergedSiblings || [];

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { proofRule: null, supersederPr: null, reason: null };
  }

  // Rule 1: linked-issue-closed-by-sibling (closed issue + merged sibling closes same issue)
  const r1 = proveLinkedIssueSiblingClosed(prNumber, closingIssues, mergedSiblings);
  if (r1.proved) {
    return {
      proofRule: PROOF_RULES.LINKED_ISSUE_SIBLING,
      supersederPr: r1.supersederPr,
      reason: r1.reason,
    };
  }

  // Rule 2: sibling-merged (merged sibling closes same issue, issue may still be open)
  const ownIssueNumbers = (closingIssues || []).map((i) => Number(i.number));
  const r2 = proveSiblingMerged(prNumber, ownIssueNumbers, mergedSiblings);
  if (r2.proved) {
    return {
      proofRule: PROOF_RULES.SIBLING_MERGED,
      supersederPr: r2.supersederPr,
      reason: r2.reason,
    };
  }

  // Rule 3: empty-diff (all changes already on main)
  const r3 = proveEmptyDiff(pr);
  if (r3.proved) {
    return {
      proofRule: PROOF_RULES.EMPTY_DIFF,
      supersederPr: null,
      reason: r3.reason,
    };
  }

  // No deterministic proof — caller must route to quarantine, not auto-close.
  return { proofRule: null, supersederPr: null, reason: null };
}
