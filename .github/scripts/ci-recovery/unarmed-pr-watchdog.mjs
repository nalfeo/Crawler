/**
 * unarmed-pr-watchdog.mjs — Dormant unarmed-auto-merge PR detector.
 *
 * Addresses issue #2453: when repository automation advances a PR's head commit
 * (via update-branch, conflict-coordinator rebase, or merge-train branch
 * update), GitHub silently clears any armed auto-merge.  The PR then sits
 * indefinitely with green-looking state, produces no failing check and no new
 * event, and never merges — externally indistinguishable from a healthy PR.
 *
 * This module provides a CHEAP, STATELESS detection signal:
 *
 *   A PR with `mergeable_state === 'clean'` and `auto_merge === null` that is
 *   NOT gated by an external mechanism (merge-train queue, human approval,
 *   conflict coordinator, lifecycle quarantine/abandon, or explicit opt-out)
 *   SHOULD have auto-merge armed.  Finding it unarmed is a high-confidence
 *   dormancy indicator.
 *
 * `detectUnarmedMergeablePrs` is a pure filter — it performs no I/O and is
 * safe to call inside any GitHub Actions script step.  The liveness sweep
 * (`ci-liveness-sweep.yml`) runs it every 10 minutes and dispatches a fresh
 * CI Recovery reconcile run for each detected dormant PR so the loop can
 * re-arm auto-merge once CI is confirmed passing on the current head.
 *
 * Note on `mergeable_state`:
 *   'clean'    → all required checks passing, not behind base, no conflicts.
 *                This is the state where CI Recovery would arm auto-merge.
 *   'behind'   → not yet up-to-date with base; reconcile calls update-branch
 *                first, then auto-merge is armed on the new head.
 *   'blocked'  → waiting on a required check or branch-protection rule.
 *   'dirty'    → merge conflicts.
 *   'unstable' → non-required checks failing.
 *
 * Only 'clean' PRs are targeted here; 'behind' and 'blocked' PRs are already
 * handled by the regular reconcile cycle triggered by CI completion events.
 */

/**
 * Labels that indicate CI Recovery should NOT arm auto-merge for a PR.
 * A PR carrying any of these labels is legitimately unarmed.
 */
export const UNARMED_WATCHDOG_BLOCKED_LABELS = new Set([
  'merge-train', // PR is in the merge-train queue; the train owns its merge
  'merge-train-blocked', // merge-train: blocked from admission
  'merge-train-validation-failed', // merge-train: validation failure
  'human-approval-required', // human must explicitly approve before merging
  'ci-conflict-order-wait', // conflict coordinator: waiting for ordering
  'ci-conflict-escalation', // conflict coordinator: conflict escalated
  'ci-lifecycle-quarantined', // PR lifecycle: quarantined from automation
  'ci-lifecycle-abandoned', // PR lifecycle: abandoned by automation
  'ci-recovery-opt-out', // PR explicitly opted out of CI Recovery
]);

/**
 * Cheap pre-filter over the SIMPLE pull request representation returned by
 * `GET /repos/{owner}/{repo}/pulls` (the list endpoint).
 *
 * The list endpoint does NOT include `mergeable`/`mergeable_state` — those are
 * computed on demand and only returned by `GET /repos/.../pulls/{number}`.
 * Callers therefore must hydrate candidates with `pulls.get` before running
 * `detectUnarmedMergeablePrs`.  This helper narrows the hydration set to PRs
 * that can still qualify using only list-representation fields (`state`,
 * `draft`, `auto_merge`, `labels`), so the watchdog spends one extra API call
 * per *plausible* PR rather than per open PR.
 *
 * @param {{state?: string, draft?: boolean, auto_merge?: object|null, labels?: Array<{name: string}>}} pr
 * @returns {boolean} true when the PR is worth hydrating.
 */
export function isUnarmedWatchdogCandidate(pr) {
  if (!pr) return false;
  if (String(pr.state || '').toLowerCase() !== 'open') return false;
  if (pr.draft) return false;
  if (pr.auto_merge !== null && pr.auto_merge !== undefined) return false;
  const labelNames = (pr.labels || []).map((l) => String(l.name || ''));
  return !labelNames.some((name) => UNARMED_WATCHDOG_BLOCKED_LABELS.has(name));
}

/**
 * Filters a list of pull request objects (as returned by the GitHub REST API)
 * and returns those that appear dormant because auto-merge is not armed despite
 * the PR being fully ready to merge.
 *
 * A PR matches if ALL of the following hold:
 *   1. `state === 'open'`
 *   2. `draft` is falsy
 *   3. `mergeable_state === 'clean'`
 *   4. `auto_merge` is null or undefined (not armed)
 *   5. No label in UNARMED_WATCHDOG_BLOCKED_LABELS
 *
 * @param {Array<{
 *   number: number,
 *   state: string,
 *   draft?: boolean,
 *   mergeable_state?: string,
 *   auto_merge?: object|null,
 *   labels?: Array<{name: string}>,
 * }>} pulls - Pull request objects in the FULL representation (i.e. hydrated
 *   via `pulls.get`); the list endpoint omits `mergeable_state`.
 * @returns {Array} The subset of `pulls` that are dormant unarmed.
 */
export function detectUnarmedMergeablePrs(pulls) {
  return pulls.filter((pr) => {
    if (String(pr.state || '').toLowerCase() !== 'open') return false;
    if (pr.draft) return false;
    if (pr.mergeable_state !== 'clean') return false;
    if (pr.auto_merge !== null && pr.auto_merge !== undefined) return false;
    const labelNames = (pr.labels || []).map((l) => String(l.name || ''));
    if (labelNames.some((name) => UNARMED_WATCHDOG_BLOCKED_LABELS.has(name))) return false;
    return true;
  });
}
