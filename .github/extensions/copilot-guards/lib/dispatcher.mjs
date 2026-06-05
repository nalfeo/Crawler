// Guard dispatcher.
//
// Walks registered guards in order. Each guard's `matches()` decides
// if it applies to this tool call. Applicable guards run `check()`.
//
// Decision semantics:
//   - first 'deny' from a shell/edit guard wins (fail fast on danger)
//   - PR guards aggregate into one combined deny message
//   - 'ask' decisions propagate as 'ask' with combined reason
//   - additionalContext snippets are concatenated and returned even on allow
//   - guards that throw are logged and treated per their failClosed flag

import { isGuardEnabled, bypassReason } from "./config.mjs";

/**
 * @typedef {Object} GuardResult
 * @property {'allow'|'deny'|'ask'|'skip'} decision
 * @property {string} [reason]
 * @property {string} [additionalContext]
 */

/**
 * @typedef {Object} Guard
 * @property {string} id
 * @property {(toolName: string, toolArgs: unknown) => boolean} matches
 * @property {(toolArgs: unknown, ctx: GuardContext) => Promise<GuardResult>|GuardResult} check
 * @property {boolean} [failClosed]  // on exception, deny instead of allow
 * @property {'shell'|'edit'|'pr'|'other'} [category]
 */

/**
 * @typedef {Object} GuardContext
 * @property {string} cwd
 * @property {(msg: string, opts?: object) => Promise<void>} log
 */

export async function dispatch(guards, toolName, toolArgs, ctx) {
    const additionalContexts = [];
    const prDenies = []; // aggregate
    const prAsks = [];

    for (const guard of guards) {
        if (!guard.matches(toolName, toolArgs)) continue;

        if (!isGuardEnabled(guard.id)) {
            const reason = bypassReason(guard.id);
            await safeLog(ctx, `guard ${guard.id} bypassed (${reason})`, {
                level: "warning",
            });
            continue;
        }

        let result;
        try {
            result = await guard.check(toolArgs, ctx);
        } catch (err) {
            await safeLog(ctx, `guard ${guard.id} crashed: ${err.message}`, {
                level: "error",
            });
            if (guard.failClosed) {
                return {
                    permissionDecision: "deny",
                    permissionDecisionReason: `Guard ${guard.id} crashed and is configured fail-closed: ${err.message}. To bypass, set COPILOT_GUARDS_DISABLE=${guard.id}.`,
                };
            }
            continue;
        }

        if (!result || result.decision === "skip" || result.decision === "allow") {
            if (result?.additionalContext) additionalContexts.push(result.additionalContext);
            continue;
        }

        if (result.decision === "deny") {
            if (guard.category === "pr") {
                prDenies.push({ id: guard.id, reason: result.reason });
                continue;
            }
            return {
                permissionDecision: "deny",
                permissionDecisionReason: formatDeny(guard.id, result.reason),
            };
        }

        if (result.decision === "ask") {
            if (guard.category === "pr") {
                prAsks.push({ id: guard.id, reason: result.reason });
                continue;
            }
            return {
                permissionDecision: "ask",
                permissionDecisionReason: formatDeny(guard.id, result.reason),
            };
        }
    }

    if (prDenies.length > 0) {
        return {
            permissionDecision: "deny",
            permissionDecisionReason: formatPrAggregate(prDenies, prAsks),
        };
    }
    if (prAsks.length > 0) {
        return {
            permissionDecision: "ask",
            permissionDecisionReason: formatPrAggregate([], prAsks),
        };
    }

    if (additionalContexts.length > 0) {
        return {
            permissionDecision: "allow",
            additionalContext: additionalContexts.join("\n\n"),
        };
    }
    return undefined; // no opinion → default permission flow
}

function formatDeny(id, reason) {
    return `[copilot-guards/${id}] ${reason}`;
}

function formatPrAggregate(denies, asks) {
    const lines = ["PR preflight failed. Fix the following before retrying create_pull_request:"];
    for (const d of denies) {
        lines.push(`  ❌ [${d.id}] ${d.reason}`);
    }
    for (const a of asks) {
        lines.push(`  ❓ [${a.id}] ${a.reason}`);
    }
    lines.push("");
    lines.push("To bypass a specific guard (legitimate edge cases only): set COPILOT_GUARDS_DISABLE=<guard-id> in the environment.");
    return lines.join("\n");
}

async function safeLog(ctx, msg, opts) {
    try {
        await ctx.log?.(msg, opts);
    } catch {
        /* never let logging break the dispatcher */
    }
}
