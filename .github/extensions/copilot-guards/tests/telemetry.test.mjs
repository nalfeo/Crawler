import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emitGuardTelemetry, getGuardTelemetryLogPath } from '../lib/telemetry.mjs';

test('emitGuardTelemetry calls log with structured JSON', async () => {
  const logged = [];
  const log = async (msg, opts) => logged.push({ msg, opts });

  await emitGuardTelemetry(log, {
    guard_id: 'test-guard',
    tool_name: 'powershell',
    decision: 'deny',
    reason: 'bad command',
  });

  assert.equal(logged.length, 1);
  assert.match(logged[0].msg, /\[guard-telemetry\]/);
  const payload = JSON.parse(logged[0].msg.replace('[guard-telemetry] ', ''));
  assert.equal(payload._type, 'guard-telemetry');
  assert.equal(payload.guard_id, 'test-guard');
  assert.equal(payload.tool_name, 'powershell');
  assert.equal(payload.decision, 'deny');
  assert.equal(payload.reason, 'bad command');
  assert.ok(payload.ts); // ISO timestamp present
});

test('emitGuardTelemetry includes bypass fields when present', async () => {
  const logged = [];
  const log = async (msg) => logged.push(msg);

  await emitGuardTelemetry(log, {
    guard_id: 'edit-determinism',
    tool_name: 'edit',
    decision: 'bypass',
    bypass_used: true,
    bypass_reason: 'COPILOT_GUARDS_DISABLE=* set',
  });

  const payload = JSON.parse(logged[0].replace('[guard-telemetry] ', ''));
  assert.equal(payload.bypass_used, true);
  assert.equal(payload.bypass_reason, 'COPILOT_GUARDS_DISABLE=* set');
});

test('emitGuardTelemetry appends JSONL artifact inside worktree files directory', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'guard-telemetry-'));
  try {
    await emitGuardTelemetry(
      async () => {},
      {
        guard_id: 'pr-preflight',
        tool_name: 'create_pull_request',
        decision: 'deny',
        reason: 'missing handoff',
      },
      { cwd },
    );

    const filePath = getGuardTelemetryLogPath(cwd);
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.schema, 'agent-os-guard-telemetry-event/v1');
    assert.equal(payload.guard_id, 'pr-preflight');
    assert.equal(payload.tool_name, 'create_pull_request');
    assert.equal(payload.decision, 'deny');
    assert.equal(payload.reason, 'missing handoff');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('emitGuardTelemetry swallows log failures silently', async () => {
  const log = async () => {
    throw new Error('log broken');
  };

  // Should not throw
  await emitGuardTelemetry(log, {
    guard_id: 'x',
    tool_name: 'y',
    decision: 'allow',
  });
});

test('emitGuardTelemetry handles null log gracefully', async () => {
  // Should not throw
  await emitGuardTelemetry(null, {
    guard_id: 'x',
    tool_name: 'y',
    decision: 'allow',
  });
});
