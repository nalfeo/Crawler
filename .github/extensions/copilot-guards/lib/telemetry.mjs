// Telemetry emission for copilot-guards.
//
// Emits structured JSON log events on every guard decision so that
// chronicle (session_store_sql) can be queried for guard fire-rates,
// false positives, dead guards, and bypass patterns.
//
// Format: session.log() with a structured message prefixed by
// [guard-telemetry] for easy grep/filtering in chronicle events.

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
 */
export async function emitGuardTelemetry(log, event) {
    try {
        const payload = {
            _type: "guard-telemetry",
            ts: new Date().toISOString(),
            ...event,
        };
        await log(`[guard-telemetry] ${JSON.stringify(payload)}`, { level: "info" });
    } catch {
        /* telemetry must never break the dispatcher */
    }
}
