import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertEarlyTableInvariant,
  assertTerminalTableInvariant,
  buildEarlyDecisionTable,
  buildTerminalDecisionTable,
  DISPATCH_ACTION,
  selectEarlyAction,
  selectTerminalAction,
} from './dispatch-table.mjs';

// ─── structural invariant ────────────────────────────────────────────────────

test('buildEarlyDecisionTable: does not throw (invariant holds)', () => {
  assert.doesNotThrow(() => buildEarlyDecisionTable());
});

test('assertEarlyTableInvariant: RELEASE rows before OWNER-BLIND SKIP rows is valid', () => {
  const rows = [
    { id: 'R04', action: DISPATCH_ACTION.RELEASE_EXPIRED_SHEPHERD },
    { id: 'R05', action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT },
    { id: 'R03', action: DISPATCH_ACTION.SKIP_ACTIVE_SHEPHERD },
    { id: 'R06', action: DISPATCH_ACTION.SKIP_MERGE_TRAIN_OWNED },
    { id: 'R07', action: DISPATCH_ACTION.SKIP_CI_CONFLICT_ORDER_WAIT },
  ];
  assert.doesNotThrow(() => assertEarlyTableInvariant(rows));
});

test('assertEarlyTableInvariant: RELEASE after OWNER-BLIND SKIP throws (D5 violation)', () => {
  const rows = [
    { id: 'R06', action: DISPATCH_ACTION.SKIP_MERGE_TRAIN_OWNED },
    { id: 'R05', action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT },
  ];
  assert.throws(() => assertEarlyTableInvariant(rows), {
    message: /D5 invariant violated/,
  });
});

test('assertEarlyTableInvariant: RELEASE after SKIP_ACTIVE_SHEPHERD is valid (owner-aware skip)', () => {
  // R03 (SKIP_ACTIVE_SHEPHERD) is owner-aware, not owner-blind — no D5 concern.
  const rows = [
    { id: 'R03', action: DISPATCH_ACTION.SKIP_ACTIVE_SHEPHERD },
    { id: 'R05', action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT },
  ];
  assert.doesNotThrow(() => assertEarlyTableInvariant(rows));
});

test('assertEarlyTableInvariant: RELEASE after WAIT_CONFLICT_REBASE_PENDING throws (D5 violation via R09)', () => {
  // R09 (WAIT_CONFLICT_REBASE_PENDING) is owner-blind — placing R05 after it would
  // strand a stale automation lock on a conflicted PR.
  const rows = [
    { id: 'R09', action: DISPATCH_ACTION.WAIT_CONFLICT_REBASE_PENDING },
    { id: 'R05', action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT },
  ];
  assert.throws(() => assertEarlyTableInvariant(rows), {
    message: /D5 invariant violated/,
  });
});

test('assertEarlyTableInvariant: RELEASE after WAIT_CONFLICT_REBASE_BACKOFF throws (D5 violation via R10)', () => {
  // R10 (WAIT_CONFLICT_REBASE_BACKOFF) is owner-blind — same reasoning as R09.
  const rows = [
    { id: 'R10', action: DISPATCH_ACTION.WAIT_CONFLICT_REBASE_BACKOFF },
    { id: 'R05', action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT },
  ];
  assert.throws(() => assertEarlyTableInvariant(rows), {
    message: /D5 invariant violated/,
  });
});

test('early table: every row id and action is defined', () => {
  const table = buildEarlyDecisionTable();
  for (const row of table) {
    assert.ok(row.id, `row missing id: ${JSON.stringify(row)}`);
    assert.ok(row.action, `row ${row.id} missing action`);
    assert.ok(
      Object.values(DISPATCH_ACTION).includes(row.action),
      `row ${row.id} unknown action ${row.action}`,
    );
    assert.strictEqual(typeof row.guard, 'function', `row ${row.id} guard is not a function`);
  }
});

// ─── selectEarlyAction ───────────────────────────────────────────────────────

const baseCtx = {
  labelExists: false,
  owner: 'none',
  status: 'idle',
  shepherdLeaseExpired: false,
  automationLeaseStale: false,
  mergeTrainEnabled: false,
  pendingHumanApproval: false,
  hasMergeConflict: false,
  hasQueueLabel: false,
  hasCiConflictOrderWait: false,
  trainShortCircuits: false,
  trigger: 'workflow_dispatch',
  rebaseDispatchPendingForHead: false,
  rebaseDispatchAttemptsForHead: 0,
  rebaseFailureBackoffActive: false,
  rebaseRetryAttemptsExhausted: false,
  autoRebaseFailed: false,
};

test('selectEarlyAction: returns null when no row matches (no-op context)', () => {
  const result = selectEarlyAction(baseCtx);
  assert.strictEqual(result, null);
});

test('selectEarlyAction: R03 fires for active shepherd', () => {
  const ctx = { ...baseCtx, labelExists: true, owner: 'shepherd', shepherdLeaseExpired: false };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.SKIP_ACTIVE_SHEPHERD);
  assert.strictEqual(row?.id, 'R03');
});

test('selectEarlyAction: R04 fires for expired shepherd', () => {
  const ctx = { ...baseCtx, labelExists: true, owner: 'shepherd', shepherdLeaseExpired: true };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.RELEASE_EXPIRED_SHEPHERD);
  assert.strictEqual(row?.id, 'R04');
  assert.strictEqual(row?.nonTerminal, true);
});

test('selectEarlyAction: R05 fires for stale automation with conflict', () => {
  const ctx = {
    ...baseCtx,
    labelExists: true,
    owner: 'automation',
    status: 'dispatched',
    automationLeaseStale: true,
    hasMergeConflict: true,
    trainShortCircuits: false,
  };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT);
  assert.strictEqual(row?.id, 'R05');
});

test('selectEarlyAction: R05 fires for stale automation with train short-circuits', () => {
  const ctx = {
    ...baseCtx,
    labelExists: true,
    owner: 'automation',
    status: 'active',
    automationLeaseStale: true,
    hasMergeConflict: false,
    trainShortCircuits: true,
  };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT);
});

test('selectEarlyAction: R05 does NOT fire without conflict or train short-circuits', () => {
  const ctx = {
    ...baseCtx,
    labelExists: true,
    owner: 'automation',
    status: 'active',
    automationLeaseStale: true,
    hasMergeConflict: false,
    trainShortCircuits: false,
  };
  const row = selectEarlyAction(ctx);
  assert.notStrictEqual(row?.action, DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT);
});

test('selectEarlyAction: R06 fires for merge-train-owned without human approval', () => {
  const ctx = {
    ...baseCtx,
    mergeTrainEnabled: true,
    pendingHumanApproval: false,
    hasQueueLabel: true,
  };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.SKIP_MERGE_TRAIN_OWNED);
  assert.strictEqual(row?.id, 'R06');
});

test('selectEarlyAction: R06 does NOT fire when pendingHumanApproval', () => {
  const ctx = {
    ...baseCtx,
    mergeTrainEnabled: true,
    pendingHumanApproval: true,
    hasQueueLabel: true,
  };
  const row = selectEarlyAction(ctx);
  assert.notStrictEqual(row?.action, DISPATCH_ACTION.SKIP_MERGE_TRAIN_OWNED);
});

test('selectEarlyAction: R07 fires for ci-conflict-order-wait', () => {
  const ctx = {
    ...baseCtx,
    mergeTrainEnabled: true,
    pendingHumanApproval: false,
    hasCiConflictOrderWait: true,
  };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.SKIP_CI_CONFLICT_ORDER_WAIT);
  assert.strictEqual(row?.id, 'R07');
});

test('selectEarlyAction: R09 fires for pending rebase in backoff (non-failure trigger)', () => {
  const ctx = {
    ...baseCtx,
    mergeTrainEnabled: true,
    hasMergeConflict: true,
    trigger: 'workflow_dispatch',
    rebaseDispatchPendingForHead: true,
    rebaseFailureBackoffActive: true,
    rebaseRetryAttemptsExhausted: false,
    autoRebaseFailed: false,
  };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.WAIT_CONFLICT_REBASE_PENDING);
  assert.strictEqual(row?.id, 'R09');
});

test('selectEarlyAction: R09 does NOT fire for auto-rebase-failure trigger', () => {
  const ctx = {
    ...baseCtx,
    mergeTrainEnabled: true,
    hasMergeConflict: true,
    trigger: 'auto-rebase-failure',
    rebaseDispatchPendingForHead: true,
    rebaseFailureBackoffActive: true,
    autoRebaseFailed: true,
  };
  const row = selectEarlyAction(ctx);
  assert.notStrictEqual(row?.action, DISPATCH_ACTION.WAIT_CONFLICT_REBASE_PENDING);
});

test('selectEarlyAction: R10 fires for auto-rebase-failure in backoff', () => {
  const ctx = {
    ...baseCtx,
    mergeTrainEnabled: true,
    hasMergeConflict: true,
    trigger: 'auto-rebase-failure',
    autoRebaseFailed: true,
    rebaseFailureBackoffActive: true,
  };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.WAIT_CONFLICT_REBASE_BACKOFF);
  assert.strictEqual(row?.id, 'R10');
});

test('selectEarlyAction: R08 fires for merge conflict with no prior dispatch', () => {
  const ctx = {
    ...baseCtx,
    mergeTrainEnabled: true,
    hasMergeConflict: true,
    trigger: 'workflow_dispatch',
    rebaseDispatchPendingForHead: false,
    rebaseRetryAttemptsExhausted: false,
    rebaseFailureBackoffActive: false,
    autoRebaseFailed: false,
  };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.DISPATCH_CONFLICT_REBASE);
  assert.strictEqual(row?.id, 'R08');
});

test('selectEarlyAction: R11 fires for retry after backoff elapses', () => {
  const ctx = {
    ...baseCtx,
    mergeTrainEnabled: true,
    hasMergeConflict: true,
    trigger: 'workflow_dispatch',
    rebaseDispatchPendingForHead: true,
    rebaseRetryAttemptsExhausted: false,
    rebaseFailureBackoffActive: false,
    autoRebaseFailed: false,
  };
  const row = selectEarlyAction(ctx);
  assert.strictEqual(row?.action, DISPATCH_ACTION.RETRY_CONFLICT_REBASE);
  assert.strictEqual(row?.id, 'R11');
});

test('selectEarlyAction: no conflict rebase rows fire when auto-rebase-conflict trigger', () => {
  const ctx = {
    ...baseCtx,
    mergeTrainEnabled: true,
    hasMergeConflict: true,
    trigger: 'auto-rebase-conflict',
    rebaseDispatchPendingForHead: false,
    rebaseRetryAttemptsExhausted: false,
  };
  const row = selectEarlyAction(ctx);
  const conflictActions = new Set([
    DISPATCH_ACTION.DISPATCH_CONFLICT_REBASE,
    DISPATCH_ACTION.RETRY_CONFLICT_REBASE,
    DISPATCH_ACTION.WAIT_CONFLICT_REBASE_PENDING,
    DISPATCH_ACTION.WAIT_CONFLICT_REBASE_BACKOFF,
  ]);
  assert.ok(
    row === null || !conflictActions.has(row.action),
    `unexpected conflict rebase action ${row?.action} for auto-rebase-conflict trigger`,
  );
});

// ─── TERMINAL_DECISIONS table (D5, issue #1858) ─────────────────────────────

test('buildTerminalDecisionTable: does not throw and returns 9 well-formed rows', () => {
  const table = buildTerminalDecisionTable();
  assert.strictEqual(table.length, 9);
  const ids = new Set();
  for (const row of table) {
    assert.ok(row.id, `row missing id: ${JSON.stringify(row)}`);
    assert.ok(!ids.has(row.id), `duplicate row id ${row.id}`);
    ids.add(row.id);
    assert.ok(row.action, `row ${row.id} missing action`);
    assert.ok(
      Object.values(DISPATCH_ACTION).includes(row.action),
      `row ${row.id} unknown action ${row.action}`,
    );
    assert.strictEqual(typeof row.guard, 'function', `row ${row.id} guard is not a function`);
  }
  assert.deepStrictEqual(
    [...ids],
    [
      'R26',
      'R27',
      'R28',
      'GC-EXHAUSTED-SKIP',
      'R34',
      'GC-DUPLICATE-WAIT',
      'R33',
      'GC-COPILOT-PROGRESS',
      'DISPATCH',
    ],
  );
});

test('terminal table: exactly one non-terminal row (R33), matching RELEASE_STALE_AUTOMATION_RETRY', () => {
  const table = buildTerminalDecisionTable();
  const nonTerminalRows = table.filter((row) => row.nonTerminal);
  assert.strictEqual(nonTerminalRows.length, 1);
  assert.strictEqual(nonTerminalRows[0].id, 'R33');
  assert.strictEqual(nonTerminalRows[0].action, DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_RETRY);
});

const baseTerminalCtx = {
  blockersPresent: true,
  admissionWaitingCount: 0,
  live: false,
  mergeTrainEnabled: false,
  labelExists: false,
  owner: 'none',
  status: 'idle',
  stateTrigger: null,
  stateProgressKey: null,
  currentProgressKey: 'key-a',
  isDuplicateDispatch: false,
  stallAction: 'new',
  automationProgressRecent: false,
};

test('selectTerminalAction: R26 fires for admission-wait with no blockers', () => {
  const ctx = { ...baseTerminalCtx, blockersPresent: false, admissionWaitingCount: 2 };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.id, 'R26');
  assert.strictEqual(row.action, DISPATCH_ACTION.WAIT_ADMISSION);
});

test('selectTerminalAction: R27 fires for a clean PR in live merge-train mode', () => {
  const ctx = {
    ...baseTerminalCtx,
    blockersPresent: false,
    admissionWaitingCount: 0,
    live: true,
    mergeTrainEnabled: true,
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.id, 'R27');
  assert.strictEqual(row.action, DISPATCH_ACTION.QUEUE_MERGE_TRAIN);
});

test('selectTerminalAction: R28 fires for a clean PR when dry-run (even with mergeTrainEnabled)', () => {
  // `live` gate on R27: a dry-run with mergeTrainEnabled still falls through to
  // ARM_AUTO_MERGE rather than QUEUE_MERGE_TRAIN — see dispatch-table.mjs R27 doc.
  const ctx = {
    ...baseTerminalCtx,
    blockersPresent: false,
    admissionWaitingCount: 0,
    live: false,
    mergeTrainEnabled: true,
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.id, 'R28');
  assert.strictEqual(row.action, DISPATCH_ACTION.ARM_AUTO_MERGE);
});

test('selectTerminalAction: R28 fires for a clean PR when merge train is disabled', () => {
  const ctx = { ...baseTerminalCtx, blockersPresent: false, admissionWaitingCount: 0, live: true };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.id, 'R28');
  assert.strictEqual(row.action, DISPATCH_ACTION.ARM_AUTO_MERGE);
});

test('selectTerminalAction: GC-EXHAUSTED-SKIP fires when state already converged to stale-automation-exhausted for this progress key', () => {
  const ctx = {
    ...baseTerminalCtx,
    labelExists: false,
    owner: 'none',
    status: 'idle',
    stateTrigger: 'stale-automation-exhausted',
    stateProgressKey: 'key-a',
    currentProgressKey: 'key-a',
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.id, 'GC-EXHAUSTED-SKIP');
  assert.strictEqual(row.action, DISPATCH_ACTION.SKIP_STALE_AUTOMATION_EXHAUSTED);
});

test('selectTerminalAction: GC-EXHAUSTED-SKIP does NOT fire when the progress key has moved on (new head/fingerprint)', () => {
  const ctx = {
    ...baseTerminalCtx,
    labelExists: false,
    owner: 'none',
    status: 'idle',
    stateTrigger: 'stale-automation-exhausted',
    stateProgressKey: 'key-a',
    currentProgressKey: 'key-b',
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.DISPATCH_COPILOT);
});

test('selectTerminalAction: R34 fires when duplicate dispatch reaches the stale-retry ceiling', () => {
  const ctx = {
    ...baseTerminalCtx,
    labelExists: true,
    isDuplicateDispatch: true,
    stallAction: 'release',
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.id, 'R34');
  assert.strictEqual(row.action, DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_EXHAUSTED);
});

test('selectTerminalAction: GC-DUPLICATE-WAIT fires when duplicate dispatch is still within its liveness window', () => {
  const ctx = {
    ...baseTerminalCtx,
    labelExists: true,
    isDuplicateDispatch: true,
    stallAction: 'wait',
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.id, 'GC-DUPLICATE-WAIT');
  assert.strictEqual(row.action, DISPATCH_ACTION.SKIP_DUPLICATE_FINGERPRINT);
});

test('selectTerminalAction: R33 fires (non-terminal) for a duplicate dispatch neither exhausted nor waiting', () => {
  for (const stallAction of ['retry', 'progressed']) {
    const ctx = { ...baseTerminalCtx, labelExists: true, isDuplicateDispatch: true, stallAction };
    const row = selectTerminalAction(ctx);
    assert.strictEqual(row.id, 'R33', `stallAction=${stallAction}`);
    assert.strictEqual(row.action, DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_RETRY);
    assert.strictEqual(row.nonTerminal, true);
  }
});

test('selectTerminalAction: GC-COPILOT-PROGRESS fires for a fresh (non-duplicate) recent automation lease', () => {
  const ctx = {
    ...baseTerminalCtx,
    labelExists: true,
    isDuplicateDispatch: false,
    owner: 'automation',
    status: 'active',
    automationProgressRecent: true,
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.id, 'GC-COPILOT-PROGRESS');
  assert.strictEqual(row.action, DISPATCH_ACTION.SKIP_ACTIVE_COPILOT_PROGRESS);
});

test('selectTerminalAction: DISPATCH fires as the has-blockers catch-all (fresh lock, no owner)', () => {
  const row = selectTerminalAction(baseTerminalCtx);
  assert.strictEqual(row.id, 'DISPATCH');
  assert.strictEqual(row.action, DISPATCH_ACTION.DISPATCH_COPILOT);
});

test('selectTerminalAction: DISPATCH fires when GC-COPILOT-PROGRESS conditions are stale (progress window elapsed)', () => {
  const ctx = {
    ...baseTerminalCtx,
    labelExists: true,
    isDuplicateDispatch: false,
    owner: 'automation',
    status: 'active',
    automationProgressRecent: false,
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.DISPATCH_COPILOT);
});

test('selectTerminalAction: never throws across a full combinatorial sweep of realistic contexts (exhaustiveness)', () => {
  const boolFlags = [false, true];
  const owners = ['none', 'automation', 'shepherd'];
  const statuses = ['idle', 'active', 'dispatched', 'waiting'];
  const stallActions = ['new', 'wait', 'release', 'retry', 'progressed'];
  let evaluated = 0;
  for (const blockersPresent of boolFlags) {
    for (const admissionWaitingCount of [0, 1]) {
      for (const live of boolFlags) {
        for (const mergeTrainEnabled of boolFlags) {
          for (const labelExists of boolFlags) {
            for (const owner of owners) {
              for (const status of statuses) {
                for (const isDuplicateDispatch of boolFlags) {
                  for (const stallAction of stallActions) {
                    for (const automationProgressRecent of boolFlags) {
                      evaluated += 1;
                      const ctx = {
                        blockersPresent,
                        admissionWaitingCount,
                        live,
                        mergeTrainEnabled,
                        labelExists,
                        owner,
                        status,
                        stateTrigger: null,
                        stateProgressKey: null,
                        currentProgressKey: 'key',
                        isDuplicateDispatch,
                        stallAction,
                        automationProgressRecent,
                      };
                      assert.doesNotThrow(
                        () => selectTerminalAction(ctx),
                        `unmapped context: ${JSON.stringify(ctx)}`,
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  // Sanity check the sweep itself actually iterated a non-trivial number of
  // combinations rather than silently degenerating to zero.
  assert.ok(evaluated > 1000, `sweep only evaluated ${evaluated} combinations`);
});

test('selectTerminalAction: the two catch-all rows (R28, DISPATCH) are load-bearing for the "fails loudly on unmapped" guarantee', () => {
  // The full table can never fail to match because R28 (`!blockersPresent`)
  // and DISPATCH (`blockersPresent`) partition every possible boolean value
  // of `blockersPresent`. This test proves that guarantee is NOT vacuous: with
  // those two catch-all rows removed, an otherwise-unremarkable context falls
  // through the remaining rows unmatched, which is exactly the "unmapped
  // context" case `selectTerminalAction` is documented to fail loudly on.
  const reducedTable = buildTerminalDecisionTable().filter(
    (row) => row.id !== 'R28' && row.id !== 'DISPATCH',
  );
  const unmatchedCtx = { ...baseTerminalCtx, blockersPresent: false, admissionWaitingCount: 0 };
  const match = reducedTable.find((row) => row.guard(unmatchedCtx));
  assert.strictEqual(
    match,
    undefined,
    'expected no row to match once both catch-all rows are removed',
  );
});

test('selectTerminalAction: R33 no longer absorbs an unrecognised stallAction (narrowed guard, plan review 2026-07-27)', () => {
  // R33 used to match on isDuplicateDispatch alone; it now requires
  // stallAction to be explicitly 'retry' or 'progressed' so a future/unknown
  // stallAction value falls through instead of being silently swallowed here.
  const ctx = {
    ...baseTerminalCtx,
    labelExists: true,
    isDuplicateDispatch: true,
    stallAction: 'new',
  };
  const row = selectTerminalAction(ctx);
  assert.notStrictEqual(row.id, 'R33');
  // With isDuplicateDispatch true, GC-COPILOT-PROGRESS is excluded by its own
  // guard, so this falls all the way to the DISPATCH catch-all.
  assert.strictEqual(row.id, 'DISPATCH');
});

// ─── terminal table structural invariant (assertTerminalTableInvariant) ────

test('assertTerminalTableInvariant: does not throw for the real table', () => {
  assert.doesNotThrow(() => assertTerminalTableInvariant(buildTerminalDecisionTable()));
});

test('assertTerminalTableInvariant: throws when more than one row is marked non-terminal', () => {
  const rows = buildTerminalDecisionTable().map((row) =>
    row.id === 'GC-COPILOT-PROGRESS' ? { ...row, nonTerminal: true } : row,
  );
  assert.throws(() => assertTerminalTableInvariant(rows), /exactly one non-terminal row/);
});

test('assertTerminalTableInvariant: throws when the non-terminal row is not R33', () => {
  const rows = buildTerminalDecisionTable().map((row) => ({
    ...row,
    nonTerminal: row.id === 'DISPATCH',
  }));
  assert.throws(() => assertTerminalTableInvariant(rows), /exactly one non-terminal row/);
});

test('assertTerminalTableInvariant: throws when has-blockers sub-path rows are reordered', () => {
  const rows = buildTerminalDecisionTable();
  const r33Idx = rows.findIndex((row) => row.id === 'R33');
  const gcProgressIdx = rows.findIndex((row) => row.id === 'GC-COPILOT-PROGRESS');
  const reordered = [...rows];
  [reordered[r33Idx], reordered[gcProgressIdx]] = [reordered[gcProgressIdx], reordered[r33Idx]];
  assert.throws(() => assertTerminalTableInvariant(reordered), /must appear in the order/);
});

test('assertTerminalTableInvariant: throws when DISPATCH is not the final row', () => {
  // Append a trailing dummy row after DISPATCH so the required-order check
  // (which only cares about relative order, unaffected by appending) stays
  // satisfied and this isolates the dedicated "DISPATCH must be last" check.
  const rows = [
    ...buildTerminalDecisionTable(),
    {
      id: 'EXTRA-UNREACHABLE',
      dClass: 'core',
      action: DISPATCH_ACTION.DISPATCH_COPILOT,
      description: 'dummy row appended after DISPATCH to test finality',
      guard: () => false,
    },
  ];
  assert.throws(() => assertTerminalTableInvariant(rows), /must be the/);
});

test('assertTerminalTableInvariant: throws when R28 does not precede the has-blockers sub-path', () => {
  const rows = buildTerminalDecisionTable();
  const r28Idx = rows.findIndex((row) => row.id === 'R28');
  const gcExhaustedIdx = rows.findIndex((row) => row.id === 'GC-EXHAUSTED-SKIP');
  const reordered = [...rows];
  [reordered[r28Idx], reordered[gcExhaustedIdx]] = [reordered[gcExhaustedIdx], reordered[r28Idx]];
  assert.throws(() => assertTerminalTableInvariant(reordered), /must precede/);
});

test('assertTerminalTableInvariant: throws when R28 is moved ahead of R26/R27 (code review, 2026-07-27)', () => {
  // R28 (ARM_AUTO_MERGE) is an unconditional catch-all for the no-blockers
  // sub-path, matched via Array.prototype.find()'s first-match semantics.
  // If R28 were ever reordered ahead of R26 (WAIT_ADMISSION) or R27
  // (QUEUE_MERGE_TRAIN), those two rows would become permanently
  // unreachable dead code — every no-blockers PR would silently skip
  // admission-wait / merge-train queueing. This case is distinct from (and
  // not caught by) the R28-vs-has-blockers-subpath check above, since here
  // R28 still precedes GC-EXHAUSTED-SKIP; only its position relative to
  // R26/R27 is wrong.
  const rows = buildTerminalDecisionTable();
  const withoutR28 = rows.filter((row) => row.id !== 'R28');
  const r28Row = rows.find((row) => row.id === 'R28');
  const reordered = [r28Row, ...withoutR28];
  assert.throws(() => assertTerminalTableInvariant(reordered), /must come AFTER/);
});
