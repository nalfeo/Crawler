import assert from 'node:assert/strict';
import test from 'node:test';

import { DISPATCH_ACTION } from './dispatch-table.mjs';
import {
  buildEarlyDecisionRecord,
  buildTerminalDecisionRecord,
  DECISION_LOG_MARKER,
  formatDecisionLog,
  sanitizeTrigger,
  terminalTaskCommentIntent,
} from './decision-log.mjs';

const COMMON = {
  prNumber: 2078,
  headSha: 'abc123',
  timestamp: '2026-07-27T04:40:02.000Z',
  trigger: 'pull_request_review',
  stateAttempt: 0,
  shepherdLeaseExpired: false,
  mergeTrainOwned: false,
};

// ─── terminalTaskCommentIntent ──────────────────────────────────────────────

test('terminalTaskCommentIntent: DISPATCH_COPILOT live → planned', () => {
  assert.equal(terminalTaskCommentIntent(DISPATCH_ACTION.DISPATCH_COPILOT, true), 'planned');
});

test('terminalTaskCommentIntent: DISPATCH_COPILOT dry-run → dry-run', () => {
  assert.equal(terminalTaskCommentIntent(DISPATCH_ACTION.DISPATCH_COPILOT, false), 'dry-run');
});

test('terminalTaskCommentIntent: any non-dispatch action → not-applicable (live or dry)', () => {
  for (const action of [
    DISPATCH_ACTION.WAIT_ADMISSION,
    DISPATCH_ACTION.SKIP_ACTIVE_SHEPHERD,
    DISPATCH_ACTION.RELEASE_EXPIRED_SHEPHERD,
    'some-unknown-action',
  ]) {
    assert.equal(terminalTaskCommentIntent(action, true), 'not-applicable', `${action} live`);
    assert.equal(terminalTaskCommentIntent(action, false), 'not-applicable', `${action} dry`);
  }
});

// ─── formatDecisionLog ──────────────────────────────────────────────────────

test('formatDecisionLog: prefixes the greppable marker and a single space', () => {
  const line = formatDecisionLog({ pr: 1, stage: 'early' });
  assert.ok(line.startsWith(`${DECISION_LOG_MARKER} `));
});

test('formatDecisionLog: payload after the marker round-trips as valid JSON', () => {
  const record = buildEarlyDecisionRecord({
    common: COMMON,
    ctx: { owner: 'shepherd', status: 'active', labelExists: true },
    row: { id: 'R03', action: DISPATCH_ACTION.SKIP_ACTIVE_SHEPHERD },
  });
  const line = formatDecisionLog(record);
  const payload = line.slice(DECISION_LOG_MARKER.length + 1);
  assert.deepEqual(JSON.parse(payload), record);
});

test('formatDecisionLog: is a single line even when a field contains newlines/quotes', () => {
  const line = formatDecisionLog({ stage: 'terminal', evil: 'a\nb"c\r' });
  // JSON.stringify escapes control chars, so the serialized line has no raw newline.
  assert.equal(line.split('\n').length, 1);
  const payload = JSON.parse(line.slice(DECISION_LOG_MARKER.length + 1));
  assert.equal(payload.evil, 'a\nb"c\r');
});

// ─── buildEarlyDecisionRecord ───────────────────────────────────────────────

test('buildEarlyDecisionRecord: maps row + ctx + common into the early shape', () => {
  const record = buildEarlyDecisionRecord({
    common: { ...COMMON, stateAttempt: 2, shepherdLeaseExpired: true, mergeTrainOwned: true },
    ctx: {
      owner: 'shepherd',
      status: 'active',
      labelExists: true,
      automationLeaseStale: true,
      mergeTrainEnabled: true,
      pendingHumanApproval: true,
      hasMergeConflict: true,
      hasQueueLabel: true,
      hasCiConflictOrderWait: true,
      rebaseDispatchPendingForHead: true,
      rebaseFailureBackoffActive: true,
      rebaseRetryAttemptsExhausted: true,
      autoRebaseFailed: true,
    },
    row: { id: 'R03', action: DISPATCH_ACTION.SKIP_ACTIVE_SHEPHERD },
  });
  assert.equal(record.stage, 'early');
  assert.equal(record.pr, 2078);
  assert.equal(record.head, 'abc123');
  assert.equal(record.row, 'R03');
  assert.equal(record.action, DISPATCH_ACTION.SKIP_ACTIVE_SHEPHERD);
  assert.equal(record.owner, 'shepherd');
  assert.equal(record.status, 'active');
  assert.equal(record.stateAttempt, 2);
  assert.equal(record.shepherdLeaseExpired, true);
  assert.equal(record.mergeTrainOwned, true);
  // early decisions never summon copilot
  assert.equal(record.taskComment, 'not-applicable');
});

test('buildEarlyDecisionRecord: coerces missing/undefined boolean ctx fields to false', () => {
  const record = buildEarlyDecisionRecord({
    common: COMMON,
    ctx: { owner: 'none', status: 'idle' },
    row: { id: 'R05', action: DISPATCH_ACTION.RELEASE_STALE_AUTOMATION_CONFLICT },
  });
  assert.equal(record.labelExists, false);
  assert.equal(record.automationLeaseStale, false);
  assert.equal(record.autoRebaseFailed, false);
});

// ─── buildTerminalDecisionRecord ────────────────────────────────────────────

test('buildTerminalDecisionRecord: dispatch in live mode reports taskComment planned', () => {
  const record = buildTerminalDecisionRecord({
    common: COMMON,
    ctx: {
      owner: 'none',
      status: 'idle',
      labelExists: false,
      mergeTrainEnabled: false,
      live: true,
      admissionWaitingCount: 0,
      isDuplicateDispatch: false,
      stallAction: 'none',
      automationProgressRecent: false,
      stateTrigger: null,
      stateProgressKey: 'k1',
      currentProgressKey: 'k1',
    },
    row: { id: 'R99', action: DISPATCH_ACTION.DISPATCH_COPILOT },
    terminalPass: 0,
    fingerprint: 'fp-1',
    blockerKinds: ['ci-failure', 'review-thread'],
    blockerCount: 3,
  });
  assert.equal(record.stage, 'terminal');
  assert.equal(record.action, DISPATCH_ACTION.DISPATCH_COPILOT);
  assert.equal(record.taskComment, 'planned');
  assert.equal(record.terminalPass, 0);
  assert.equal(record.fingerprint, 'fp-1');
  assert.equal(record.blockerCount, 3);
  assert.deepEqual(record.blockerKinds, ['ci-failure', 'review-thread']);
  assert.equal(record.progressKeyMatches, true);
});

test('buildTerminalDecisionRecord: dispatch in dry-run reports taskComment dry-run', () => {
  const record = buildTerminalDecisionRecord({
    common: COMMON,
    ctx: {
      owner: 'none',
      status: 'idle',
      live: false,
      stateProgressKey: 'k1',
      currentProgressKey: 'k2',
    },
    row: { id: 'R99', action: DISPATCH_ACTION.DISPATCH_COPILOT },
    terminalPass: 1,
    fingerprint: 'fp-2',
    blockerKinds: [],
    blockerCount: 0,
  });
  assert.equal(record.taskComment, 'dry-run');
  assert.equal(record.progressKeyMatches, false);
});

test('buildTerminalDecisionRecord: non-dispatch action reports taskComment not-applicable', () => {
  const record = buildTerminalDecisionRecord({
    common: COMMON,
    ctx: { owner: 'automation', status: 'active', live: true },
    row: { id: 'R26', action: DISPATCH_ACTION.WAIT_ADMISSION },
    terminalPass: 0,
    fingerprint: 'fp-3',
    blockerKinds: ['ci-failure'],
    blockerCount: 1,
  });
  assert.equal(record.taskComment, 'not-applicable');
  assert.equal(record.action, DISPATCH_ACTION.WAIT_ADMISSION);
});

// ─── staleRetryCeilingReached (cap/ceiling determinant) ─────────────────────

test("buildTerminalDecisionRecord: staleRetryCeilingReached true only when stallAction === 'release'", () => {
  const base = {
    common: COMMON,
    row: { id: 'R99', action: DISPATCH_ACTION.DISPATCH_COPILOT },
    terminalPass: 0,
    fingerprint: 'fp',
    blockerKinds: [],
    blockerCount: 0,
  };
  // 'release' is the stale-automation exhaustion ceiling (stallAttempt >= 2).
  const hit = buildTerminalDecisionRecord({
    ...base,
    ctx: { owner: 'automation', status: 'active', live: true, stallAction: 'release' },
  });
  assert.equal(hit.staleRetryCeilingReached, true);
  // every other stallAction is under the ceiling.
  for (const stallAction of ['retry', 'wait', 'progressed', 'new', 'none', undefined]) {
    const rec = buildTerminalDecisionRecord({
      ...base,
      ctx: { owner: 'automation', status: 'active', live: true, stallAction },
    });
    assert.equal(rec.staleRetryCeilingReached, false, `stallAction=${stallAction}`);
  }
});

// ─── sanitizeTrigger (bounded, raw-preserving) ──────────────────────────────

test('sanitizeTrigger: preserves null and short raw values verbatim', () => {
  assert.equal(sanitizeTrigger(null), null);
  assert.equal(sanitizeTrigger(undefined), null);
  assert.equal(sanitizeTrigger('pull_request_review'), 'pull_request_review');
  assert.equal(sanitizeTrigger('schedule'), 'schedule');
  // anomalous-but-short values are kept raw so a stall investigation can see them.
  assert.equal(sanitizeTrigger('weird-unexpected-value'), 'weird-unexpected-value');
});

test('sanitizeTrigger: coerces non-strings and truncates unbounded input', () => {
  assert.equal(sanitizeTrigger(42), '42');
  const long = 'x'.repeat(500);
  const out = sanitizeTrigger(long);
  assert.ok(out.length <= 121, `truncated length ${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.ok(out.startsWith('xxxx'));
});

test('buildTerminalDecisionRecord: sanitizes trigger and stateTrigger', () => {
  const record = buildTerminalDecisionRecord({
    common: { ...COMMON, trigger: 'y'.repeat(300) },
    ctx: {
      owner: 'none',
      status: 'idle',
      live: true,
      stallAction: 'none',
      stateTrigger: 'z'.repeat(300),
    },
    row: { id: 'R99', action: DISPATCH_ACTION.DISPATCH_COPILOT },
    terminalPass: 0,
    fingerprint: 'fp',
    blockerKinds: [],
    blockerCount: 0,
  });
  assert.ok(record.trigger.length <= 121 && record.trigger.endsWith('…'));
  assert.ok(record.stateTrigger.length <= 121 && record.stateTrigger.endsWith('…'));
  // absent stateTrigger stays null (parity with the pre-fix `?? null`).
  const nullState = buildTerminalDecisionRecord({
    common: COMMON,
    ctx: { owner: 'none', status: 'idle', live: true, stallAction: 'none', stateTrigger: null },
    row: { id: 'R99', action: DISPATCH_ACTION.DISPATCH_COPILOT },
    terminalPass: 0,
    fingerprint: 'fp',
    blockerKinds: [],
    blockerCount: 0,
  });
  assert.equal(nullState.stateTrigger, null);
});
