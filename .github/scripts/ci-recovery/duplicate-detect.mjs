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
 *   1. EMPTY_DIFF — PR diff is zero (all changes already on main) AND the PR has
 *      aged past the empty-diff grace window with no recent activity.
 *
 * Grace window (incident: PR #2948):
 *   A freshly opened PR with an active agent session legitimately has a zero
 *   diff until the agent pushes its first commit. Closing it as a "provable
 *   duplicate" destroys in-flight work. An empty diff is only proof of
 *   redundancy once the PR has been empty long enough that no one is still
 *   working on it, so EMPTY_DIFF requires BOTH:
 *     - PR age    >= EMPTY_DIFF_MIN_AGE_MS since createdAt, and
 *     - quiescence >= EMPTY_DIFF_MIN_QUIET_MS since the last updatedAt.
 *   Unknown/unparseable timestamps (now, createdAt or updatedAt) are treated as
 *   "too young" (conservatism). See evaluateCloseGrace(), which callers should
 *   reuse for any other auto-close path so every path shares one grace rule.
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

/** Minimum PR age before an empty diff counts as proof of redundancy. */
export const EMPTY_DIFF_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/** Minimum quiet period since the last PR update before an empty diff counts. */
export const EMPTY_DIFF_MIN_QUIET_MS = 60 * 60 * 1000;

/** Parse an ISO timestamp to epoch ms, or null when absent/unparseable. */
function parseTimestamp(value) {
  if (value === null || value === undefined) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Shared close-grace evaluation used by every auto-close path.
 *
 * A PR may only be auto-closed once it is BOTH aged past
 * EMPTY_DIFF_MIN_AGE_MS and quiet for at least EMPTY_DIFF_MIN_QUIET_MS.
 * Every timestamp must be known and finite: `nowMs`, `createdAt` and
 * `updatedAt` are each fail-closed, so an absent or unparseable value makes the
 * PR "too fresh" rather than silently falling back to another timestamp.
 *
 * @param {{ createdAt?: string, updatedAt?: string }} pr
 * @param {{ nowMs?: number, minAgeMs?: number, minQuietMs?: number }} [options]
 * @returns {{ tooFresh: boolean, reason: string|null, ageMs: number|null, quietMs: number|null }}
 */
export function evaluateCloseGrace(pr, options = {}) {
  const minAgeMs = Number.isFinite(Number(options.minAgeMs))
    ? Number(options.minAgeMs)
    : EMPTY_DIFF_MIN_AGE_MS;
  const minQuietMs = Number.isFinite(Number(options.minQuietMs))
    ? Number(options.minQuietMs)
    : EMPTY_DIFF_MIN_QUIET_MS;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : null;

  const createdMs = parseTimestamp(pr?.createdAt);
  const updatedMs = parseTimestamp(pr?.updatedAt);

  // Unknown timestamps → treat as freshly opened (never auto-close).
  if (nowMs === null || createdMs === null || updatedMs === null) {
    return { tooFresh: true, reason: 'unknown-timestamps', ageMs: null, quietMs: null };
  }

  const ageMs = nowMs - createdMs;
  const quietMs = nowMs - updatedMs;
  if (ageMs < minAgeMs) return { tooFresh: true, reason: 'pr-too-young', ageMs, quietMs };
  if (quietMs < minQuietMs) return { tooFresh: true, reason: 'recent-activity', ageMs, quietMs };
  return { tooFresh: false, reason: null, ageMs, quietMs };
}

/**
 * Try proof rule EMPTY_DIFF:
 *   - The PR's diff against its base is zero: additions + deletions = 0, AND
 *   - the PR is old enough and quiet enough that no session is still filling it.
 *
 * @param {{ additions: number, deletions: number, createdAt?: string, updatedAt?: string }} pr
 * @param {{ nowMs?: number, minAgeMs?: number, minQuietMs?: number }} [options]
 * @returns {{ proved: boolean, reason: string|null }}
 */
export function proveEmptyDiff(pr, options = {}) {
  const additions = Number(pr?.additions ?? -1);
  const deletions = Number(pr?.deletions ?? -1);
  if (additions < 0 || deletions < 0) {
    // Unknown diff size — conservatively cannot prove
    return { proved: false, reason: null };
  }
  if (additions !== 0 || deletions !== 0) {
    return { proved: false, reason: null };
  }

  const grace = evaluateCloseGrace(pr, {
    nowMs: options.nowMs,
    minAgeMs: options.minAgeMs,
    minQuietMs: options.minQuietMs,
  });
  if (grace.tooFresh) {
    return { proved: false, reason: null };
  }

  return { proved: true, reason: 'zero-additions-zero-deletions-aged-out' };
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
 * @param {{ number: number, additions?: number, deletions?: number, createdAt?: string, updatedAt?: string }} pr
 * @param {{
 *   closingIssues?: { number: number, state: string }[];
 *   mergedSiblings?: { number: number, merged: boolean, closingIssueNumbers: number[] }[];
 *   nowMs?: number;
 *   minAgeMs?: number;
 *   minQuietMs?: number;
 * }} context
 * @returns {{
 *   proofRule: string|null,
 *   supersederPr: number|null,
 *   reason: string|null
 * }}
 */
export function detectDuplicateProof(pr, context = {}) {
  const prNumber = Number(pr?.number);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { proofRule: null, supersederPr: null, reason: null };
  }

  // SIBLING_MERGED is quarantine evidence only — NOT an auto-close proof.
  // Two PRs can legitimately reference the same issue (feature + tests, etc.);
  // "sibling merged + same issue" alone is not deterministic proof of redundancy.
  // The caller must use detectQuarantineEvidence() for suspicion-based quarantine.

  // Rule 1: empty-diff (all changes already on main), gated on age + quiescence
  // so an in-flight agent session on a brand-new PR is never closed.
  const r1 = proveEmptyDiff(pr, {
    nowMs: context.nowMs,
    minAgeMs: context.minAgeMs,
    minQuietMs: context.minQuietMs,
  });
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
