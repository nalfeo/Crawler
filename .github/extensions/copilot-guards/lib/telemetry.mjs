// Telemetry emission for copilot-guards.
//
// Emits structured JSON log events on every guard decision so that
// chronicle (session_store_sql) can be queried for guard fire-rates,
// false positives, dead guards, and bypass patterns.
//
// Also appends the same payload to a session-local JSONL artifact under
// `files/guard-telemetry.jsonl` inside the active worktree. Agents can
// summarize that file into the session handoff so telemetry survives across
// desktop and cloud sessions without depending on Chronicle queryability.

import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {Object} TelemetryEvent
 * @property {string} guard_id
 * @property {string} tool_name
 * @property {'deny'|'ask'|'allow'|'skip'|'bypass'|'crash'} decision
 * @property {string} [reason]
 * @property {boolean} [bypass_used]
 * @property {string} [bypass_reason]
 */

/**
 * Emit a telemetry event via session.log().
 * Failures are silently swallowed — telemetry must never break the guard pipeline.
 *
 * @param {(msg: string, opts?: object) => Promise<void>} log
 * @param {TelemetryEvent} event
 * @param {{ cwd?: string }} [options]
 */
export async function emitGuardTelemetry(log, event, options = {}) {
  const payload = {
    schema: 'agent-os-guard-telemetry-event/v1',
    _type: 'guard-telemetry',
    ts: new Date().toISOString(),
    ...event,
  };
  try {
    await log(`[guard-telemetry] ${JSON.stringify(payload)}`, { level: 'info' });
  } catch {
    /* telemetry must never break the dispatcher */
  }
  try {
    const logPath = getGuardTelemetryLogPath(options.cwd);
    if (!logPath) return;
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    /* telemetry must never break the dispatcher */
  }
}

export function getGuardTelemetryLogPath(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  return path.join(cwd, 'files', 'guard-telemetry.jsonl');
}
