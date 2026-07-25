import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertEarlyTableInvariant,
  buildEarlyDecisionTable,
  buildTerminalDispatchTable,
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
    assert.ok(Object.values(DISPATCH_ACTION).includes(row.action), `row ${row.id} unknown action ${row.action}`);
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

// ─── buildTerminalDispatchTable / selectTerminalAction ───────────────────────

test('buildTerminalDispatchTable: returns a non-empty array with valid rows', () => {
  const table = buildTerminalDispatchTable();
  assert.ok(Array.isArray(table) && table.length > 0, 'expected non-empty table');
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

const baseTerminal = {
  normalizedBlockers: [],
  admissionWaiting: [],
  mergeTrainEnabled: false,
  labelExists: false,
  owner: 'none',
  status: 'idle',
  isDuplicateDispatch: false,
  stallAction: null,
  stateProgressKey: null,
  currentProgressKey: 'k1',
  stateTrigger: null,
  copilotAssigned: false,
  automationProgressAgeMs: Infinity,
};

test('selectTerminalAction: clean non-train PR → ARM_AUTO_MERGE', () => {
  const row = selectTerminalAction(baseTerminal);
  assert.strictEqual(row.action, DISPATCH_ACTION.ARM_AUTO_MERGE);
  assert.strictEqual(row.id, 'T-ARM');
});

test('selectTerminalAction: clean train PR → QUEUE_MERGE_TRAIN', () => {
  const ctx = { ...baseTerminal, mergeTrainEnabled: true };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.QUEUE_MERGE_TRAIN);
  assert.strictEqual(row.id, 'R27');
});

test('selectTerminalAction: clean PR with admission-wait reasons → WAIT_ADMISSION', () => {
  const ctx = { ...baseTerminal, admissionWaiting: ['check:ci'] };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.WAIT_ADMISSION);
  assert.strictEqual(row.id, 'R26');
});

test('selectTerminalAction: blockers present → DISPATCH_COPILOT (catch-all)', () => {
  const ctx = {
    ...baseTerminal,
    normalizedBlockers: [{ kind: 'review-thread', id: 't1', summary: 's' }],
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.DISPATCH_COPILOT);
  assert.strictEqual(row.id, 'T-DISPATCH');
});

test('selectTerminalAction: stale-automation-exhausted idle state → SKIP_STALE_AUTOMATION_EXHAUSTED', () => {
  const ctx = {
    ...baseTerminal,
    normalizedBlockers: [{ kind: 'ci-failure', id: 'c1', summary: 's' }],
    labelExists: false,
    owner: 'none',
    status: 'idle',
    stateProgressKey: 'k1',
    currentProgressKey: 'k1',
    stateTrigger: 'stale-automation-exhausted',
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.SKIP_STALE_AUTOMATION_EXHAUSTED);
  assert.strictEqual(row.id, 'T-EXHAUSTED');
});

test('selectTerminalAction: duplicate dispatch stallAction=release → RELEASE_STALE_AUTOMATION_EXHAUSTED', () => {
  const ctx = {
    ...baseTerminal,
    normalizedBlockers: [{ kind: 'ci-failure', id: 'c1', summary: 's' }],
    labelExists: true,
    isDuplicateDispatch: true,
    stallAction: 'release',
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_EXHAUSTED);
  assert.strictEqual(row.id, 'R34');
});

test('selectTerminalAction: duplicate dispatch stallAction=wait → SKIP_DUPLICATE_FINGERPRINT', () => {
  const ctx = {
    ...baseTerminal,
    normalizedBlockers: [{ kind: 'ci-failure', id: 'c1', summary: 's' }],
    labelExists: true,
    isDuplicateDispatch: true,
    stallAction: 'wait',
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.SKIP_DUPLICATE_FINGERPRINT);
  assert.strictEqual(row.id, 'R33');
});

test('selectTerminalAction: active copilot in progress → SKIP_ACTIVE_COPILOT_PROGRESS', () => {
  const ctx = {
    ...baseTerminal,
    normalizedBlockers: [{ kind: 'ci-failure', id: 'c1', summary: 's' }],
    labelExists: true,
    owner: 'automation',
    status: 'active',
    copilotAssigned: true,
    automationProgressAgeMs: 5 * 60 * 1000, // 5 minutes — within the 30-minute window
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.SKIP_ACTIVE_COPILOT_PROGRESS);
  assert.strictEqual(row.id, 'T-COPILOT-PROGRESS');
});

test('selectTerminalAction: active copilot older than 30 min falls through to DISPATCH_COPILOT', () => {
  const ctx = {
    ...baseTerminal,
    normalizedBlockers: [{ kind: 'ci-failure', id: 'c1', summary: 's' }],
    labelExists: true,
    owner: 'automation',
    status: 'active',
    copilotAssigned: true,
    automationProgressAgeMs: 31 * 60 * 1000, // 31 minutes — outside the 30-minute window
  };
  const row = selectTerminalAction(ctx);
  assert.strictEqual(row.action, DISPATCH_ACTION.DISPATCH_COPILOT);
});

