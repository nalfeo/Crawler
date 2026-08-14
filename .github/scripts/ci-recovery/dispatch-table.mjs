/**
 * dispatch-table.mjs — Data-driven dispatch table for CI-recovery reconcile.
 *
 * SCOPE:
 *   EARLY_DECISIONS table: ordered rows (R03–R12) that fire against cheap
 *   context before any expensive API calls (review threads, check runs).
 *
 *   TERMINAL_DECISIONS table: ordered rows (R26–R34/GC) that fire once
 *   blockers/admission facts are known — the "what do we do about this PR
 *   right now" decision (wait for admission, queue/arm merge, GC a stale
 *   automation lock, or dispatch @copilot).
 *
 *   Both tables return the first matching row via `selectEarlyAction`/
 *   `selectTerminalAction`. The early table may return `null` (continue to
 *   the main pipeline); the terminal table is exhaustive by construction
 *   (its last row in each sub-path is an unconditional catch-all) and
 *   `selectTerminalAction` throws if a context still fails to match, so an
 *   unmapped owner/status/blocker/train-state combination fails loudly
 *   instead of silently falling through.
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
 * TERMINAL_DECISIONS ordering notes (see buildTerminalDecisionTable() for the
 * full rationale of each row):
 *   - GC (RELEASE_STALE_AUTOMATION_RETRY) is the terminal table's own
 *     non-terminal row (mirrors R04): it releases a stale-but-not-yet-exhausted
 *     automation lock and continues, exactly like R04 does for shepherd leases.
 *   - SKIP_ACTIVE_COPILOT_PROGRESS's guard excludes `isDuplicateDispatch` cases
 *     because production reaches that check only *after* the duplicate-dispatch
 *     release has already fired (flipping `labelExists` false) — see the driver
 *     wiring comment in reconcile.mjs for the full trace.
 *
 * Design source: docs/knowledge/ci-recovery/2026-07-20-harness-holistic-review.md §7.4
 * Fixes: D5 (release-unreachable-behind-short-circuits) and all of §5.3.
 * Terminal wiring closes issue #1858 (D5 dispatch table, terminal half).
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
  /**
   * GC: duplicate fingerprint, not yet exhausted (stallAction 'retry'; the
   * 'progressed' stallAction is listed defensively in this row's guard but is
   * not reachable from real callers, since `isDuplicateDispatch` requires an
   * exact fingerprint match while 'progressed' requires a fingerprint
   * mismatch — see buildTerminalDecisionTable()): release the stale-but-not-
   * exhausted lock and continue (non-terminal — driver re-evaluates the
   * remaining table rows, mirrors R04).
   */
  RELEASE_STALE_AUTOMATION_RETRY: 'release-stale-automation-retry',
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
 * (R06, R07, R09, R10) bypassing release logic; owner-aware exits do not carry
 * this risk.
 *
 * NOTE: R09 (WAIT_CONFLICT_REBASE_PENDING) and R10 (WAIT_CONFLICT_REBASE_BACKOFF)
 * are also owner-blind terminal waits.  Including them here ensures the invariant
 * fires if R05 is ever moved below them — a placement that would strand a stale
 * automation lock on a conflicted PR just as R06/R07 do.
 */
const EARLY_RELEASE_ACTIONS = new Set([
  DISPATCH_ACTION.RELEASE_EXPIRED_SHEPHERD,
  DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT,
]);

const EARLY_OWNER_BLIND_SKIP_ACTIONS = new Set([
  DISPATCH_ACTION.SKIP_MERGE_TRAIN_OWNED,
  DISPATCH_ACTION.SKIP_CI_CONFLICT_ORDER_WAIT,
  DISPATCH_ACTION.WAIT_CONFLICT_REBASE_PENDING,
  DISPATCH_ACTION.WAIT_CONFLICT_REBASE_BACKOFF,
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
      guard: (ctx) => ctx.labelExists && ctx.owner === 'shepherd' && ctx.shepherdLeaseExpired,
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
      guard: (ctx) => ctx.labelExists && ctx.owner === 'shepherd' && !ctx.shepherdLeaseExpired,
    },
    {
      id: 'R06',
      dClass: 'D1',
      action: DISPATCH_ACTION.SKIP_MERGE_TRAIN_OWNED,
      description: 'merge-train-owned short-circuit (owner-blind, after all release rows)',
      guard: (ctx) => ctx.mergeTrainEnabled && !ctx.pendingHumanApproval && ctx.hasQueueLabel,
    },
    {
      id: 'R07',
      dClass: 'D9',
      action: DISPATCH_ACTION.SKIP_CI_CONFLICT_ORDER_WAIT,
      description: 'ci-conflict-order wait short-circuit (owner-blind, after all release rows)',
      guard: (ctx) =>
        ctx.mergeTrainEnabled && !ctx.pendingHumanApproval && ctx.hasCiConflictOrderWait,
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
 * Build the TERMINAL_DECISIONS ordered dispatch table (R26–R34/GC).
 *
 * This is the "what do we do about this PR right now" decision, evaluated
 * once admission/blocker facts are known. Unlike the early table, it is
 * exhaustive by construction: every sub-path ends in an unconditional
 * catch-all row (ARM_AUTO_MERGE for the no-blockers path, DISPATCH_COPILOT
 * for the has-blockers path), so `selectTerminalAction` never legitimately
 * returns null — see its throw below for the "unmapped fails loudly"
 * acceptance criterion.
 *
 * Row ordering rationale:
 *   1. `blockersPresent === false` sub-path (R26–R28-family):
 *      - WAIT_ADMISSION first: if checks/review are still pending, nothing
 *        else in this sub-path may run.
 *      - QUEUE_MERGE_TRAIN next: ONLY when `live` — production only queues
 *        the merge train in live mode (`if (live && mergeTrainEnabled)`);
 *        a dry-run with mergeTrainEnabled still falls through to the
 *        auto-merge-arm branch. Omitting the `live` check here would be a
 *        real behavioural regression versus current production code.
 *      - ARM_AUTO_MERGE catch-all: every remaining no-blockers context
 *        (train disabled, or dry-run with train enabled).
 *   2. `blockersPresent === true` sub-path (GC + R33/R34 + dispatch):
 *      - SKIP_STALE_AUTOMATION_EXHAUSTED: label already gone, state already
 *        converged to the exhausted idle marker for this exact progress key
 *        — re-dispatching would just recreate the lock GC already cleared.
 *      - RELEASE_STALE_AUTOMATION_EXHAUSTED (R34, stallAction 'release'):
 *        duplicate dispatch has exhausted its retry budget — file an
 *        incident and release.
 *      - SKIP_DUPLICATE_FINGERPRINT (stallAction 'wait'): duplicate dispatch
 *        still within its liveness window — do nothing yet.
 *      - RELEASE_STALE_AUTOMATION_RETRY (R33, non-terminal): duplicate
 *        dispatch not yet exhausted (stallAction 'retry'). Blocker identity
 *        (the fingerprint), not the head SHA, is what `automationStallAction`
 *        treats as progress — see its NOTE in state.mjs (issue #2914 / PR
 *        #2823). Since `isDuplicateDispatch` also requires an exact
 *        fingerprint match, `stallAction === 'progressed'` cannot co-occur
 *        with `isDuplicateDispatch === true` under normal callers; it is
 *        listed alongside 'retry' here only as defensive belt-and-braces
 *        coverage, not a reachable production path. Release and re-evaluate
 *        — mirrors R04's non-terminal pattern exactly.
 *      - SKIP_ACTIVE_COPILOT_PROGRESS: only reachable once
 *        RELEASE_STALE_AUTOMATION_RETRY has NOT fired (i.e. `!isDuplicateDispatch`)
 *        — see the module doc comment for why this guard must exclude the
 *        duplicate-dispatch case.
 *      - DISPATCH_COPILOT catch-all: fresh acquire, blocker-fingerprint-changed
 *        release-then-dispatch, or resume-an-interrupted-release-then-dispatch.
 *
 * @returns {Array<{id: string, dClass: string, action: string, description: string, guard: (ctx: TerminalContext) => boolean, nonTerminal?: boolean}>}
 */
export function buildTerminalDecisionTable() {
  const rows = [
    // ── No-blockers sub-path ──────────────────────────────────────────────
    {
      id: 'R26',
      dClass: 'D1',
      action: DISPATCH_ACTION.WAIT_ADMISSION,
      description: 'admission wait: required checks pending or review not yet submitted',
      guard: (ctx) => !ctx.blockersPresent && ctx.admissionWaitingCount > 0,
    },
    {
      id: 'R27',
      dClass: 'D1',
      action: DISPATCH_ACTION.QUEUE_MERGE_TRAIN,
      description: 'clean PR, live merge-train mode: queue for the merge train',
      guard: (ctx) =>
        !ctx.blockersPresent &&
        ctx.admissionWaitingCount === 0 &&
        ctx.live &&
        ctx.mergeTrainEnabled,
    },
    {
      id: 'R28',
      dClass: 'D1',
      action: DISPATCH_ACTION.ARM_AUTO_MERGE,
      description:
        'clean PR, non-train mode (or dry-run with train enabled): arm auto-merge (catch-all for the no-blockers sub-path)',
      guard: (ctx) => !ctx.blockersPresent,
    },

    // ── Has-blockers sub-path (GC first, then dispatch) ───────────────────
    {
      id: 'GC-EXHAUSTED-SKIP',
      dClass: 'D5',
      action: DISPATCH_ACTION.SKIP_STALE_AUTOMATION_EXHAUSTED,
      description:
        'label absent, state already converged to stale-automation-exhausted for this exact progress key: skip re-dispatch',
      guard: (ctx) =>
        ctx.blockersPresent &&
        !ctx.labelExists &&
        ctx.owner === 'none' &&
        ctx.status === 'idle' &&
        // NOTE: `ctx.stateTrigger` is the *stored recovery state's* trigger
        // field (`state?.trigger`), distinct from the early table's
        // `ctx.trigger` (the current invocation's RECOVERY_TRIGGER env var).
        ctx.stateTrigger === 'stale-automation-exhausted' &&
        ctx.stateProgressKey === ctx.currentProgressKey,
    },
    {
      id: 'R34',
      dClass: 'D4',
      action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_EXHAUSTED,
      description: 'duplicate dispatch reaches the stale-retry ceiling: file incident and release',
      guard: (ctx) =>
        ctx.blockersPresent &&
        ctx.labelExists &&
        ctx.isDuplicateDispatch &&
        ctx.stallAction === 'release',
    },
    {
      id: 'GC-DUPLICATE-WAIT',
      dClass: 'D4',
      action: DISPATCH_ACTION.SKIP_DUPLICATE_FINGERPRINT,
      description: 'duplicate dispatch still within its liveness window: skip',
      guard: (ctx) =>
        ctx.blockersPresent &&
        ctx.labelExists &&
        ctx.isDuplicateDispatch &&
        ctx.stallAction === 'wait',
    },
    {
      id: 'R33',
      dClass: 'D4',
      action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_RETRY,
      description:
        'duplicate dispatch not yet exhausted (stallAction retry/progressed): release and re-evaluate (non-terminal, mirrors R04)',
      nonTerminal: true,
      // Explicit stallAction allow-list (rather than "any remaining
      // isDuplicateDispatch context"): automationStallAction() returns a closed
      // enum {'new','progressed','wait','release','retry'}; 'wait' and 'release'
      // are already peeled off by GC-DUPLICATE-WAIT/R34 above, so only
      // 'retry'/'progressed' are expected here. Naming them explicitly (plan
      // review, 2026-07-27) means a future stallAction value falls through to
      // GC-COPILOT-PROGRESS/DISPATCH instead of being silently absorbed by a
      // broad catch-most guard.
      guard: (ctx) =>
        ctx.blockersPresent &&
        ctx.labelExists &&
        ctx.isDuplicateDispatch &&
        (ctx.stallAction === 'retry' || ctx.stallAction === 'progressed'),
    },
    {
      id: 'GC-COPILOT-PROGRESS',
      dClass: 'D5',
      action: DISPATCH_ACTION.SKIP_ACTIVE_COPILOT_PROGRESS,
      description:
        'copilot assigned and progressed recently under a fresh (non-duplicate) lease: back off and skip',
      guard: (ctx) =>
        ctx.blockersPresent &&
        !ctx.isDuplicateDispatch &&
        ctx.labelExists &&
        ctx.owner === 'automation' &&
        ['active', 'dispatched'].includes(ctx.status) &&
        ctx.automationProgressRecent,
    },
    {
      id: 'DISPATCH',
      dClass: 'core',
      action: DISPATCH_ACTION.DISPATCH_COPILOT,
      description:
        'dispatch @copilot to fix the listed blockers (catch-all for the has-blockers sub-path)',
      guard: (ctx) => ctx.blockersPresent,
    },
  ];

  assertTerminalTableInvariant(rows);
  return rows;
}

/**
 * Assert the D5 structural invariant on the terminal-decision table:
 * exactly one non-terminal row (R33), the has-blockers sub-path rows appear
 * in their required dependency order, R28 precedes the has-blockers
 * sub-path (and both R26 and R27), and DISPATCH is the unconditional final
 * row.
 *
 * This is a lightweight, always-executed counterpart to the exhaustive
 * per-row/id-order unit tests in dispatch-table.test.mjs: it catches a
 * structural regression (a reordered or duplicated row) at table-build time,
 * not only when the specific unit test happens to run (plan review,
 * 2026-07-27).
 *
 * @param {Array<{id: string, action: string, nonTerminal?: boolean}>} rows
 * @throws {Error} if the invariant is violated
 */
export function assertTerminalTableInvariant(rows) {
  const nonTerminalRows = rows.filter((row) => row.nonTerminal === true);
  if (nonTerminalRows.length !== 1 || nonTerminalRows[0].id !== 'R33') {
    throw new Error(
      `dispatch-table D5 terminal invariant violated: expected exactly one non-terminal row ` +
        `(R33/RELEASE_STALE_AUTOMATION_RETRY), found [${nonTerminalRows.map((row) => row.id).join(', ')}].`,
    );
  }

  const ids = rows.map((row) => row.id);
  const requiredOrder = [
    'GC-EXHAUSTED-SKIP',
    'R34',
    'GC-DUPLICATE-WAIT',
    'R33',
    'GC-COPILOT-PROGRESS',
    'DISPATCH',
  ];
  const positions = requiredOrder.map((id) => ids.indexOf(id));
  const allOrdered = positions.every((pos, i) => pos !== -1 && (i === 0 || pos > positions[i - 1]));
  if (!allOrdered) {
    throw new Error(
      `dispatch-table D5 terminal invariant violated: has-blockers sub-path rows must appear in the ` +
        `order ${requiredOrder.join(' -> ')} (exhaustion/duplicate checks before the retry loop, ` +
        `before the fresh-progress skip, before the unconditional dispatch catch-all). ` +
        `Actual order: [${ids.join(', ')}].`,
    );
  }

  if (ids[ids.length - 1] !== 'DISPATCH') {
    throw new Error(
      `dispatch-table D5 terminal invariant violated: DISPATCH (has-blockers catch-all) must be the ` +
        `final row; found at index ${ids.indexOf('DISPATCH')} of ${ids.length}.`,
    );
  }

  const r28Idx = ids.indexOf('R28');
  const gcExhaustedIdx = ids.indexOf('GC-EXHAUSTED-SKIP');
  if (r28Idx === -1 || gcExhaustedIdx === -1 || r28Idx >= gcExhaustedIdx) {
    throw new Error(
      `dispatch-table D5 terminal invariant violated: R28 (no-blockers catch-all) must precede every ` +
        `has-blockers sub-path row.`,
    );
  }

  // R28 (ARM_AUTO_MERGE) is itself an unconditional catch-all for the
  // no-blockers sub-path, matched via Array.prototype.find()'s first-match
  // semantics. If it were ever reordered ahead of R26 (WAIT_ADMISSION) or
  // R27 (QUEUE_MERGE_TRAIN), those two rows would become permanently
  // unreachable dead code and every no-blockers PR would silently skip
  // admission-wait / merge-train queueing (code review, 2026-07-27).
  const r26Idx = ids.indexOf('R26');
  const r27Idx = ids.indexOf('R27');
  if (r26Idx === -1 || r27Idx === -1 || r28Idx <= r26Idx || r28Idx <= r27Idx) {
    throw new Error(
      `dispatch-table D5 terminal invariant violated: R28 (no-blockers catch-all) must come AFTER ` +
        `both R26 (WAIT_ADMISSION) and R27 (QUEUE_MERGE_TRAIN), or those rows become unreachable.`,
    );
  }
}

/**
 * Evaluate the terminal-decision table against a terminal context.
 *
 * @param {TerminalContext} ctx
 * @returns {{ id: string, action: string, description: string, nonTerminal?: boolean }}
 * @throws {Error} if no row matches — this table is exhaustive by
 *   construction (ARM_AUTO_MERGE / DISPATCH_COPILOT are unconditional
 *   catch-alls for their sub-path), so reaching this throw indicates a
 *   context the table was never designed to represent. Failing loudly here
 *   is the explicit acceptance-criterion behaviour for an unmapped context.
 */
export function selectTerminalAction(ctx) {
  const table = buildTerminalDecisionTable();
  const row = table.find((candidate) => candidate.guard(ctx));
  if (!row) {
    throw new Error(
      `dispatch-table: no terminal decision row matched context ${JSON.stringify(ctx)}. ` +
        `Every owner/status/blocker/train-state combination must map to exactly one terminal action.`,
    );
  }
  return row;
}
