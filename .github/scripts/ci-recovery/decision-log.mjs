/**
 * decision-log.mjs — Structured, append-only observability for the CI-recovery
 * dispatch decision.
 *
 * WHY THIS EXISTS:
 *   The authoritative recovery state lives in a single `crawler-ci-state:v1` PR
 *   comment that reconcile OVERWRITES in place every pass, so a *declined*
 *   dispatch leaves no trace of WHICH decision-table row declined or WHY. When
 *   `@copilot` is not summoned we currently cannot tell "never dispatched" from
 *   "dispatched-and-exhausted" after the fact (see the PR #2078 forensics,
 *   handoff 2026-07-27-ci-dispatch-observability).
 *
 *   The GitHub Actions workflow run log is append-only and retained for the
 *   repo's log-retention window, costs no extra API calls, and adds no PR
 *   comment noise. Emitting one structured line per decision there makes the
 *   dispatch choice diagnosable from a single grep instead of hours of forensics.
 *
 * CONTRACT (deliberately narrow — plan review, 2026-07-27):
 *   A decision line is emitted for every reconcile pass that reaches a *final
 *   dispatch-table decision* — either an early short-circuit (`selectEarlyAction`
 *   returned a row) or a terminal decision (`selectTerminalAction`). Runs that
 *   exit earlier at a startup/ownership guard (mode=off, draft, fork, metadata
 *   mismatch, orphaned-label cleanup, opt-out, closed PR, etc.) do NOT emit a
 *   decision line: those guards already log their own `skip …`/`cleanup …`
 *   reason lines and can never summon `@copilot`. So: a run with no
 *   `CI_RECOVERY_DECISION` line exited at a pre-table guard — grep the same run
 *   log for the guard's reason line.
 *
 * OBSERVABILITY ONLY: nothing here changes dispatch behavior, caps, or the
 * decision tables. It only serializes facts reconcile already holds in memory.
 */

import { DISPATCH_ACTION } from './dispatch-table.mjs';

/** Stable, greppable prefix for every decision line. `grep CI_RECOVERY_DECISION`. */
export const DECISION_LOG_MARKER = 'CI_RECOVERY_DECISION';

/**
 * The only terminal action that posts a `crawler-ci-task:v1` comment and assigns
 * `@copilot`. Every other terminal action is a wait/skip/queue/arm/release.
 */
const TASK_POSTING_ACTION = DISPATCH_ACTION.DISPATCH_COPILOT;

/**
 * Describe the intent to post a task comment for a terminal action.
 *
 * NOTE (plan review, 2026-07-27): this reports INTENT at decision time, not a
 * confirmed post. The decision line is emitted just before the release/acquire/
 * metadata-check/POST/assign sequence runs, any step of which can throw. A POST
 * failure surfaces loudly (a thrown error + non-zero exit in the same run log),
 * and the existing `assigned copilot pr=#N` line records the confirmed outcome.
 * So the value is:
 *   - 'planned'        → action is DISPATCH_COPILOT in live mode (a post is attempted)
 *   - 'dry-run'        → action is DISPATCH_COPILOT in dry-run mode (no post)
 *   - 'not-applicable' → any other action (no task comment is ever posted; the
 *                        `action` field is the specific reason @copilot was not summoned)
 *
 * @param {string} action - a DISPATCH_ACTION.* value
 * @param {boolean} live - whether reconcile is running in live (mutating) mode
 * @returns {'planned' | 'dry-run' | 'not-applicable'}
 */
export function terminalTaskCommentIntent(action, live) {
  if (action !== TASK_POSTING_ACTION) return 'not-applicable';
  return live ? 'planned' : 'dry-run';
}

/**
 * Max characters retained for a logged trigger value.
 */
const MAX_TRIGGER_LEN = 120;

/**
 * Coerce a trigger value to a bounded, safe string for logging.
 *
 * `trigger` originates from the free-form `workflow_dispatch.inputs.trigger`
 * string (`ci-recovery.yml`), and `stateTrigger` from the persisted
 * `crawler-ci-state:v1` comment — neither is a strict enum. `JSON.stringify`
 * already neutralizes control chars/quotes so the fixed-shape line cannot be
 * broken or spoofed, but an unbounded value could still bloat the line, so we
 * truncate. We deliberately keep the RAW (truncated) value rather than
 * collapsing to an allowlisted enum: the whole diagnostic point of `trigger` is
 * distinguishing a review event from the every-10-min sweep from a manual/anomalous
 * dispatch, and mapping unknowns to "other" would hide exactly the anomaly a
 * stall investigation is looking for (code review, 2026-07-27).
 *
 * @param {unknown} value
 * @returns {string | null} null is preserved (absent stateTrigger); everything
 *   else is coerced to a string and truncated to MAX_TRIGGER_LEN.
 */
export function sanitizeTrigger(value) {
  if (value == null) return null;
  const str = String(value);
  return str.length > MAX_TRIGGER_LEN ? `${str.slice(0, MAX_TRIGGER_LEN)}…` : str;
}

/**
 * Serialize a decision record to a single greppable log line.
 *
 * The record is JSON.stringify'd, which escapes control characters and quotes,
 * so a fixed-shape line cannot be broken or spoofed by field values. Callers
 * must only include enumerated scalar fields and blocker KINDS — never untrusted
 * blocker summaries or URLs (plan review, 2026-07-27).
 *
 * @param {Record<string, unknown>} record
 * @returns {string} e.g. `CI_RECOVERY_DECISION {"pr":2078,"stage":"terminal",...}`
 */
export function formatDecisionLog(record) {
  return `${DECISION_LOG_MARKER} ${JSON.stringify(record)}`;
}

/**
 * @typedef {Object} DecisionCommon
 * @property {number} prNumber
 * @property {string} headSha
 * @property {string} timestamp   ISO 8601 (reconcile's `now.toISOString()`)
 * @property {string} trigger     RECOVERY_TRIGGER (free-form reconciliation trigger: review event vs the every-10-min sweep vs manual) — bounded via sanitizeTrigger
 * @property {number} stateAttempt  the stored recovery state's attempt counter (`state?.attempt ?? 0`)
 * @property {boolean} shepherdLeaseExpired
 * @property {boolean} mergeTrainOwned  mergeTrainEnabled && the PR carries the merge-train queue label
 */

/**
 * Build the record for an early short-circuit decision (`selectEarlyAction`
 * returned a non-null row). Early short-circuits never post a task comment.
 *
 * @param {{ common: DecisionCommon, ctx: Record<string, unknown>, row: { id: string, action: string } }} args
 * @returns {Record<string, unknown>}
 */
export function buildEarlyDecisionRecord({ common, ctx, row }) {
  return {
    pr: common.prNumber,
    head: common.headSha,
    ts: common.timestamp,
    trigger: sanitizeTrigger(common.trigger),
    stage: 'early',
    row: row.id,
    action: row.action,
    // ── inputs that drive the early table ──
    owner: ctx.owner,
    status: ctx.status,
    stateAttempt: common.stateAttempt,
    labelExists: Boolean(ctx.labelExists),
    shepherdLeaseExpired: Boolean(common.shepherdLeaseExpired),
    automationLeaseStale: Boolean(ctx.automationLeaseStale),
    mergeTrainEnabled: Boolean(ctx.mergeTrainEnabled),
    mergeTrainOwned: Boolean(common.mergeTrainOwned),
    pendingHumanApproval: Boolean(ctx.pendingHumanApproval),
    hasMergeConflict: Boolean(ctx.hasMergeConflict),
    hasQueueLabel: Boolean(ctx.hasQueueLabel),
    hasCiConflictOrderWait: Boolean(ctx.hasCiConflictOrderWait),
    rebaseDispatchPendingForHead: Boolean(ctx.rebaseDispatchPendingForHead),
    rebaseFailureBackoffActive: Boolean(ctx.rebaseFailureBackoffActive),
    rebaseRetryAttemptsExhausted: Boolean(ctx.rebaseRetryAttemptsExhausted),
    autoRebaseFailed: Boolean(ctx.autoRebaseFailed),
    // early exits never summon @copilot; `action` is the specific short-circuit reason
    taskComment: 'not-applicable',
  };
}

/**
 * Build the record for a terminal decision (`selectTerminalAction`). This is the
 * line that answers "was @copilot summoned, and if not, why".
 *
 * @param {{
 *   common: DecisionCommon,
 *   ctx: Record<string, unknown>,
 *   row: { id: string, action: string },
 *   terminalPass: number,
 *   fingerprint: string,
 *   blockerKinds: string[],
 *   blockerCount: number,
 * }} args
 * @returns {Record<string, unknown>}
 */
export function buildTerminalDecisionRecord({
  common,
  ctx,
  row,
  terminalPass,
  fingerprint,
  blockerKinds,
  blockerCount,
}) {
  return {
    pr: common.prNumber,
    head: common.headSha,
    ts: common.timestamp,
    trigger: sanitizeTrigger(common.trigger),
    stage: 'terminal',
    row: row.id,
    action: row.action,
    terminalPass,
    // ── inputs that drive the terminal table ──
    owner: ctx.owner,
    status: ctx.status,
    stateAttempt: common.stateAttempt,
    labelExists: Boolean(ctx.labelExists),
    shepherdLeaseExpired: Boolean(common.shepherdLeaseExpired),
    mergeTrainEnabled: Boolean(ctx.mergeTrainEnabled),
    mergeTrainOwned: Boolean(common.mergeTrainOwned),
    live: Boolean(ctx.live),
    blockerCount,
    blockerKinds,
    admissionWaitingCount: ctx.admissionWaitingCount,
    isDuplicateDispatch: Boolean(ctx.isDuplicateDispatch),
    stallAction: ctx.stallAction,
    // Cap/ceiling that was hit (task requirement): the stale-automation retry
    // ceiling. automationStallAction returns 'release' only once the per-
    // progress-key retry count reaches its exhaustion threshold
    // (stallAttempt >= 2, state.mjs); every other value is under the ceiling.
    // Re-derived purely from the ctx.stallAction already in this snapshot — no
    // new plumbing, no behavior change (code review, 2026-07-27).
    staleRetryCeilingReached: ctx.stallAction === 'release',
    automationProgressRecent: Boolean(ctx.automationProgressRecent),
    stateTrigger: sanitizeTrigger(ctx.stateTrigger),
    fingerprint,
    progressKeyMatches: ctx.stateProgressKey === ctx.currentProgressKey,
    // 'planned' | 'dry-run' | 'not-applicable' — see terminalTaskCommentIntent
    taskComment: terminalTaskCommentIntent(row.action, Boolean(ctx.live)),
  };
}
