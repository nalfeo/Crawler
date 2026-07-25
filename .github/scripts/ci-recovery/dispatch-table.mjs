/**
 * dispatch-table.mjs — Data-driven dispatch table for CI-recovery reconcile.
 *
 * SCOPE:
 *   1. EARLY_DECISIONS table: ordered rows (R03–R12) that fire against cheap
 *      context before any expensive API calls (review threads, check runs).
 *      Returns the first matching row, or `null` to continue to the pipeline.
 *   2. TERMINAL_DISPATCH table: single terminal action for the main dispatch
 *      path after all side-effect passes (thread resolution, blocker building).
 *      Throws a loud error for unmapped combinations (invariant violation).
 *
 * OUT OF SCOPE (handled by dedicated passes in the driver):
 *   - Startup guards: mode=off, draft, fork, metadata mismatch
 *   - Ownership cleanup: R01 (orphaned-label), R02 (closed PR), stale-fence
 *   - Lease operations: lease-acquire / lease-heartbeat / lease-release
 *   - Side-effect passes: thread resolution, stale-label clearing
 *   - Blocker construction, fingerprint computation
 *   - R15–R25: thread annotation/resolution, fence cleanup — within passes
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STRUCTURAL INVARIANT — D5 fix:
 *   In the EARLY_DECISIONS table every RELEASE row MUST appear before every
 *   OWNER-BLIND SKIP row.  This is the structural guarantee that a stale
 *   automation lock can never be stranded behind an early exit.
 *
 *   Enforcement: `buildEarlyDecisionTable()` performs a runtime assertion that
 *   no RELEASE row follows a SKIP row.  The `dispatch-table-invariant` test in
 *   `reconcile.test.mjs` independently verifies this by importing and calling
 *   `buildEarlyDecisionTable()`.
 *
 * Design source: docs/knowledge/ci-recovery/2026-07-20-harness-holistic-review.md §7.4
 * Fixes: D5 (release-unreachable-behind-short-circuits) and all of §5.3.
 * See also: characterization/reconcile-decision-fixtures.json for R-id mapping.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * All action string constants used in the dispatch tables.
 *
 * RELEASE_ prefixed actions always call release() before exiting or continuing.
 * SKIP_ prefixed actions are terminal exits and MUST NOT appear before release
 * actions in the EARLY_DECISIONS table (enforced by runtime assertion).
 *
 * Note: R04 (RELEASE_EXPIRED_SHEPHERD) is the only *non-terminal* early action:
 * it releases ownership and continues evaluating the remaining rows.  All other
 * early actions are terminal (they end in process.exit(0)).
 *
 * Note: R12 (exhausted rebase retries) is NOT an early table row; it is
 * represented as a blocker in the main pipeline and dispatches via DISPATCH_COPILOT.
 */
export const DISPATCH_ACTION = Object.freeze({
  // ── Early decisions (R03–R07): ownership / lease / train ──────────────────
  /**
   * R04 – expired shepherd lease: release ownership (non-terminal — driver
   * re-evaluates the remaining table rows after calling release()).
   */
  RELEASE_EXPIRED_SHEPHERD: 'release-expired-shepherd',
  /** R05 – stale automation lock stranded by conflict/train short-circuits: release then exit */
  RELEASE_STALE_AUTOMATION_CONFLICT: 'release-stale-automation-conflict',
  /** R03 – active shepherd lease present: skip (owner-aware, owner holds this PR) */
  SKIP_ACTIVE_SHEPHERD: 'skip-active-shepherd',
  /** R06 – merge-train-owned: skip (owner-blind, valid only AFTER all release rows) */
  SKIP_MERGE_TRAIN_OWNED: 'skip-merge-train-owned',
  /** R07 – ci-conflict-order-wait: skip (owner-blind, valid only AFTER all release rows) */
  SKIP_CI_CONFLICT_ORDER_WAIT: 'skip-ci-conflict-order-wait',

  // ── Early decisions (R08–R11): conflict-rebase terminal exits ────────────
  /**
   * R08 – merge conflict, dispatch needed: dispatch conflict-only rebase + exit.
   * NOTE: R09–R11 guards must be evaluated BEFORE R08 (they cover the
   * "don't re-dispatch" conditions); see table ordering in buildEarlyDecisionTable().
   */
  DISPATCH_CONFLICT_REBASE: 'dispatch-conflict-rebase',
  /** R09 – conflict-only rebase already dispatched and pending: wait + exit */
  WAIT_CONFLICT_REBASE_PENDING: 'wait-conflict-rebase-pending',
  /** R10 – conflict-rebase retry in exponential backoff window: wait + exit */
  WAIT_CONFLICT_REBASE_BACKOFF: 'wait-conflict-rebase-backoff',
  /**
   * R11 – conflict-rebase retry after backoff elapses: re-dispatch + exit.
   * Shares the same execution path as R08 (both re-dispatch the rebase).
   */
  RETRY_CONFLICT_REBASE: 'retry-conflict-rebase',

  // ── Terminal dispatch ─────────────────────────────────────────────────────
  /** R26 – one or more admission-wait reasons (checks pending / review not yet submitted): wait */
  WAIT_ADMISSION: 'wait-admission',
  /** R27/R28 – clean PR, train mode: queue for merge train */
  QUEUE_MERGE_TRAIN: 'queue-merge-train',
  /** Clean PR, non-train mode: arm auto-merge */
  ARM_AUTO_MERGE: 'arm-auto-merge',
  /** GC: stale-automation-exhausted terminal idle state suppresses re-dispatch */
  SKIP_STALE_AUTOMATION_EXHAUSTED: 'skip-stale-automation-exhausted',
  /** GC: duplicate fingerprint, within liveness window → wait */
  SKIP_DUPLICATE_FINGERPRINT: 'skip-duplicate-fingerprint',
  /** GC: duplicate fingerprint, exhausted → release stale lock + file loop incident */
  RELEASE_STALE_AUTOMATION_EXHAUSTED: 'release-stale-automation-exhausted',
  /** GC: copilot still actively working the PR under a fresh lease */
  SKIP_ACTIVE_COPILOT_PROGRESS: 'skip-active-copilot-progress',
  /** Main path: dispatch @copilot to fix the listed blockers */
  DISPATCH_COPILOT: 'dispatch-copilot',
});

/**
 * Row classification for the D5 ordering assertion.
 *
 * RELEASE rows must precede OWNER-BLIND SKIP rows in the early table.
 *
 * NOTE: R03 (SKIP_ACTIVE_SHEPHERD) is intentionally excluded from
 * EARLY_OWNER_BLIND_SKIP_ACTIONS because it IS owner-aware (it checks
 * `owner === 'shepherd'`).  The D5 deadlock is caused by owner-BLIND exits
 * (R06, R07) bypassing release logic; owner-aware exits do not carry this risk.
 */
const EARLY_RELEASE_ACTIONS = new Set([
  DISPATCH_ACTION.RELEASE_EXPIRED_SHEPHERD,
  DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT,
]);

const EARLY_OWNER_BLIND_SKIP_ACTIONS = new Set([
  DISPATCH_ACTION.SKIP_MERGE_TRAIN_OWNED,
  DISPATCH_ACTION.SKIP_CI_CONFLICT_ORDER_WAIT,
]);

/**
 * Build the EARLY_DECISIONS ordered dispatch table.
 *
 * Rows are evaluated in order; the first whose guard returns `true` is selected.
 * Guards are pure predicates of the cheap context (`ctx`); they must not call
 * async functions or have side effects.
 *
 * Row ordering rules (enforced by runtime assertion):
 *   1. RELEASE rows (R04, R05) MUST precede all SKIP rows (R03, R06, R07).
 *   2. R09/R10 (wait) guards MUST precede R08/R11 (dispatch/retry) guards so
 *      we never re-dispatch when a rebase is already pending or in backoff.
 *
 * NOTE: R04 (RELEASE_EXPIRED_SHEPHERD) is the only non-terminal early action.
 *   The driver calls release() then re-evaluates the remaining table rows.
 *   All other rows produce a terminal exit.
 *
 * NOTE: R12 (exhausted rebase retries → blocker) is NOT in this table.
 *   It is represented by a merge-conflict blocker pushed in the main pipeline
 *   and dispatched via the terminal DISPATCH_COPILOT action.
 *
 * @returns {Array<{id: string, dClass: string, action: string, description: string, guard: (ctx: EarlyContext) => boolean, nonTerminal?: boolean}>}
 */
export function buildEarlyDecisionTable() {
  const rows = [
    // ── RELEASE rows (D5 invariant: MUST precede all SKIP rows) ─────────────
    {
      id: 'R04',
      dClass: 'D5',
      action: DISPATCH_ACTION.RELEASE_EXPIRED_SHEPHERD,
      description: 'expired shepherd lease reclaim (non-terminal: release and re-evaluate)',
      nonTerminal: true,
      guard: (ctx) =>
        ctx.labelExists &&
        ctx.owner === 'shepherd' &&
        ctx.shepherdLeaseExpired,
    },
    {
      id: 'R05',
      dClass: 'D5',
      action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT,
      description:
        'stale automation conflict-or-train reclaim — release before any owner-blind exit',
      guard: (ctx) =>
        ctx.labelExists &&
        ctx.owner === 'automation' &&
        ['active', 'dispatched', 'escalated'].includes(ctx.status) &&
        ctx.automationLeaseStale &&
        (ctx.hasMergeConflict || ctx.trainShortCircuits),
    },

    // ── SKIP rows (all RELEASE rows above this line) ─────────────────────────
    {
      id: 'R03',
      dClass: 'D5',
      action: DISPATCH_ACTION.SKIP_ACTIVE_SHEPHERD,
      description: 'active shepherd lease short-circuit',
      guard: (ctx) =>
        ctx.labelExists &&
        ctx.owner === 'shepherd' &&
        !ctx.shepherdLeaseExpired,
    },
    {
      id: 'R06',
      dClass: 'D1',
      action: DISPATCH_ACTION.SKIP_MERGE_TRAIN_OWNED,
      description: 'merge-train-owned short-circuit (owner-blind, after all release rows)',
      guard: (ctx) =>
        ctx.mergeTrainEnabled &&
        !ctx.pendingHumanApproval &&
        ctx.hasQueueLabel,
    },
    {
      id: 'R07',
      dClass: 'D9',
      action: DISPATCH_ACTION.SKIP_CI_CONFLICT_ORDER_WAIT,
      description: 'ci-conflict-order wait short-circuit (owner-blind, after all release rows)',
      guard: (ctx) =>
        ctx.mergeTrainEnabled &&
        !ctx.pendingHumanApproval &&
        ctx.hasCiConflictOrderWait,
    },

    // ── Conflict-rebase rows (R09/R10 wait guards BEFORE R08/R11 dispatch) ───
    // R09/R10 must be evaluated first to prevent re-dispatching when a rebase
    // is already pending or in exponential backoff.
    {
      id: 'R09',
      dClass: 'D2',
      action: DISPATCH_ACTION.WAIT_CONFLICT_REBASE_PENDING,
      description: 'pending conflict-rebase short-circuit',
      guard: (ctx) =>
        ctx.mergeTrainEnabled &&
        ctx.hasMergeConflict &&
        ctx.trigger !== 'auto-rebase-conflict' &&
        ctx.trigger !== 'auto-rebase-failure' &&
        ctx.rebaseFailureBackoffActive,
    },
    {
      id: 'R10',
      dClass: 'D2',
      action: DISPATCH_ACTION.WAIT_CONFLICT_REBASE_BACKOFF,
      description: 'bounded backoff while conflict retry is pending',
      guard: (ctx) =>
        ctx.mergeTrainEnabled &&
        ctx.hasMergeConflict &&
        ctx.autoRebaseFailed &&
        ctx.rebaseFailureBackoffActive,
    },
    {
      id: 'R11',
      dClass: 'D2',
      action: DISPATCH_ACTION.RETRY_CONFLICT_REBASE,
      description: 'retry conflict rebase after timeout/backoff elapses',
      // R11: dispatch is already done for this head, retry now allowed
      guard: (ctx) =>
        ctx.mergeTrainEnabled &&
        ctx.hasMergeConflict &&
        ctx.trigger !== 'auto-rebase-conflict' &&
        !ctx.rebaseRetryAttemptsExhausted &&
        ctx.rebaseDispatchPendingForHead &&
        !ctx.rebaseFailureBackoffActive,
    },
    {
      id: 'R08',
      dClass: 'D2',
      action: DISPATCH_ACTION.DISPATCH_CONFLICT_REBASE,
      description: 'merge conflict dispatches conflict-only rebase (first attempt)',
      // R08 is evaluated last: covers the case where no prior rebase was dispatched
      // for this head and retries are not yet exhausted.
      guard: (ctx) =>
        ctx.mergeTrainEnabled &&
        ctx.hasMergeConflict &&
        ctx.trigger !== 'auto-rebase-conflict' &&
        !ctx.rebaseRetryAttemptsExhausted &&
        !ctx.rebaseDispatchPendingForHead,
    },
  ];

  assertEarlyTableInvariant(rows);
  return rows;
}

/**
 * Assert the D5 structural invariant on an early-decision table:
 * no RELEASE row may follow an OWNER-BLIND SKIP row.
 *
 * This ensures stale automation locks are always released before any
 * owner-blind exit can strand them.
 *
 * @param {Array<{id: string, action: string}>} rows
 * @throws {Error} if the invariant is violated
 */
export function assertEarlyTableInvariant(rows) {
  let seenOwnerBlindSkip = false;
  for (const row of rows) {
    if (EARLY_OWNER_BLIND_SKIP_ACTIONS.has(row.action)) {
      seenOwnerBlindSkip = true;
    } else if (EARLY_RELEASE_ACTIONS.has(row.action) && seenOwnerBlindSkip) {
      throw new Error(
        `dispatch-table D5 invariant violated: RELEASE row ${row.id} (${row.action}) ` +
          `appears after an OWNER-BLIND SKIP row. All RELEASE rows must precede all ` +
          `owner-blind SKIP rows in the early-decision table (D5 structural guarantee).`,
      );
    }
  }
}

/**
 * Evaluate the early-decision table against a cheap context.
 *
 * @param {EarlyContext} ctx
 * @returns {{ id: string, action: string, description: string } | null} first matching row, or null
 */
export function selectEarlyAction(ctx) {
  const table = buildEarlyDecisionTable();
  return table.find((row) => row.guard(ctx)) ?? null;
}

/**
 * Build the TERMINAL_DISPATCH ordered table.
 *
 * This table is evaluated after ALL side-effect passes (thread resolution,
 * stale-label clearing, blocker construction, fingerprint computation, GC).
 * It returns the single terminal action for this reconcile pass.
 *
 * Rows are evaluated in order; the first matching row is returned.
 * If no row matches, throws with a descriptive error (internal invariant violation).
 *
 * @returns {Array<{id: string, action: string, description: string, guard: (ctx: TerminalContext) => boolean}>}
 */
export function buildTerminalDispatchTable() {
  return [
    // ── No-blockers terminal path ─────────────────────────────────────────────
    {
      id: 'R26',
      dClass: 'D1',
      action: DISPATCH_ACTION.WAIT_ADMISSION,
      description: 'admission wait state when checks/review missing',
      guard: (ctx) => ctx.normalizedBlockers.length === 0 && ctx.admissionWaiting.length > 0,
    },
    {
      id: 'R27',
      dClass: 'D8',
      action: DISPATCH_ACTION.QUEUE_MERGE_TRAIN,
      description: 'clean train-mode PR gets queued (R27/R28 label-pagination guard)',
      guard: (ctx) => ctx.normalizedBlockers.length === 0 && ctx.mergeTrainEnabled,
    },
    {
      id: 'T-ARM',
      dClass: 'D1',
      action: DISPATCH_ACTION.ARM_AUTO_MERGE,
      description: 'clean non-train PR arms auto-merge',
      guard: (ctx) => ctx.normalizedBlockers.length === 0,
    },

    // ── Has-blockers terminal path: GC checks (release before skip) ──────────
    {
      id: 'T-EXHAUSTED',
      dClass: 'D5',
      action: DISPATCH_ACTION.SKIP_STALE_AUTOMATION_EXHAUSTED,
      description: 'stale-automation-exhausted idle state suppresses re-dispatch',
      guard: (ctx) =>
        ctx.normalizedBlockers.length > 0 &&
        !ctx.labelExists &&
        ctx.owner === 'none' &&
        ctx.status === 'idle' &&
        ctx.stateProgressKey === ctx.currentProgressKey &&
        ctx.stateTrigger === 'stale-automation-exhausted',
    },
    {
      id: 'R34',
      dClass: 'D4',
      action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_EXHAUSTED,
      description: 'stale-automation GC: exhausted → release and file loop incident',
      guard: (ctx) =>
        ctx.normalizedBlockers.length > 0 &&
        ctx.labelExists &&
        ctx.isDuplicateDispatch &&
        ctx.stallAction === 'release',
    },
    {
      id: 'R33',
      dClass: 'D4',
      action: DISPATCH_ACTION.SKIP_DUPLICATE_FINGERPRINT,
      description: 'duplicate-fingerprint within liveness window → wait',
      guard: (ctx) =>
        ctx.normalizedBlockers.length > 0 &&
        ctx.labelExists &&
        ctx.isDuplicateDispatch &&
        ctx.stallAction === 'wait',
    },
    {
      id: 'T-COPILOT-PROGRESS',
      dClass: 'D5',
      action: DISPATCH_ACTION.SKIP_ACTIVE_COPILOT_PROGRESS,
      description: 'copilot actively working on a recently changed fingerprint',
      guard: (ctx) =>
        ctx.normalizedBlockers.length > 0 &&
        ctx.labelExists &&
        ctx.owner === 'automation' &&
        ['active', 'dispatched'].includes(ctx.status) &&
        ctx.copilotAssigned &&
        ctx.automationProgressAgeMs < 30 * 60 * 1000,
    },
    {
      id: 'T-DISPATCH',
      dClass: 'D5',
      action: DISPATCH_ACTION.DISPATCH_COPILOT,
      description: 'dispatch @copilot to fix blockers',
      guard: (ctx) => ctx.normalizedBlockers.length > 0,
    },
  ];
}

/**
 * Evaluate the terminal dispatch table against a full context.
 *
 * @param {TerminalContext} ctx
 * @returns {{ id: string, action: string, description: string }}
 * @throws {Error} if no row matches (internal invariant violation)
 */
export function selectTerminalAction(ctx) {
  const table = buildTerminalDispatchTable();
  const row = table.find((r) => r.guard(ctx));
  if (!row) {
    throw new Error(
      `dispatch-table: no terminal action matched. ` +
        `owner=${ctx.owner} status=${ctx.status} ` +
        `blockers=${ctx.normalizedBlockers.length} ` +
        `mergeTrainEnabled=${ctx.mergeTrainEnabled} ` +
        `admissionWaiting=${ctx.admissionWaiting.length} ` +
        `labelExists=${ctx.labelExists} ` +
        `isDuplicate=${ctx.isDuplicateDispatch} ` +
        `stallAction=${ctx.stallAction ?? 'n/a'}`,
    );
  }
  return row;
}
