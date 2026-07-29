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

import { isGuardEnabled, bypassReason, guardSeverity } from './config.mjs';
import { emitGuardTelemetry } from './telemetry.mjs';

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
        level: 'warning',
      });
      await emitGuardTelemetry(
        ctx.log,
        {
          guard_id: guard.id,
          tool_name: toolName,
          decision: 'bypass',
          bypass_used: true,
          bypass_reason: reason,
        },
        { cwd: ctx.cwd },
      );
      continue;
    }

    let result;
    try {
      result = await guard.check(toolArgs, ctx);
    } catch (err) {
      await safeLog(ctx, `guard ${guard.id} crashed: ${err.message}`, {
        level: 'error',
      });
      await emitGuardTelemetry(
        ctx.log,
        {
          guard_id: guard.id,
          tool_name: toolName,
          decision: 'crash',
          reason: err.message,
        },
        { cwd: ctx.cwd },
      );
      if (guard.failClosed) {
        return {
          permissionDecision: 'deny',
          permissionDecisionReason: `[copilot-guards/${guard.id} | tool:${toolName}] Guard crashed (fail-closed): ${err.message}. To bypass, set COPILOT_GUARDS_DISABLE=${guard.id}.`,
        };
      }
      continue;
    }

    if (!result || result.decision === 'skip' || result.decision === 'allow') {
      if (result?.additionalContext) additionalContexts.push(result.additionalContext);
      await emitGuardTelemetry(
        ctx.log,
        {
          guard_id: guard.id,
          tool_name: toolName,
          decision: result?.decision || 'skip',
        },
        { cwd: ctx.cwd },
      );
      continue;
    }

    // Collect additionalContext from deny/ask results too — soft
    // warnings (e.g. ADR hints from pr-preflight) should still surface
    // alongside hard failures.
    if (result.additionalContext) additionalContexts.push(result.additionalContext);

    // Severity downgrade: if config.json marks this guard as "ask",
    // weaken any "deny" to "ask". Never upgrade. Lets repo owners
    // soften an over-eager guard without disabling it.
    let decision = result.decision;
    if (decision === 'deny' && guardSeverity(guard.id, 'deny') === 'ask') {
      decision = 'ask';
    }

    await emitGuardTelemetry(
      ctx.log,
      {
        guard_id: guard.id,
        tool_name: toolName,
        decision,
        reason: result.reason,
      },
      { cwd: ctx.cwd },
    );

    if (decision === 'deny') {
      if (guard.category === 'pr') {
        prDenies.push({ id: guard.id, reason: result.reason });
        continue;
      }
      const out = {
        permissionDecision: 'deny',
        permissionDecisionReason: formatDeny(guard.id, toolName, result.reason),
      };
      if (additionalContexts.length > 0) out.additionalContext = additionalContexts.join('\n\n');
      return out;
    }

    if (decision === 'ask') {
      if (guard.category === 'pr') {
        prAsks.push({ id: guard.id, reason: result.reason });
        continue;
      }
      const out = {
        permissionDecision: 'ask',
        permissionDecisionReason: formatDeny(guard.id, toolName, result.reason),
      };
      if (additionalContexts.length > 0) out.additionalContext = additionalContexts.join('\n\n');
      return out;
    }
  }

  if (prDenies.length > 0) {
    const out = {
      permissionDecision: 'deny',
      permissionDecisionReason: formatPrAggregate(prDenies, prAsks, toolName),
    };
    if (additionalContexts.length > 0) out.additionalContext = additionalContexts.join('\n\n');
    return out;
  }
  if (prAsks.length > 0) {
    const out = {
      permissionDecision: 'ask',
      permissionDecisionReason: formatPrAggregate([], prAsks, toolName),
    };
    if (additionalContexts.length > 0) out.additionalContext = additionalContexts.join('\n\n');
    return out;
  }

  if (additionalContexts.length > 0) {
    return {
      permissionDecision: 'allow',
      additionalContext: additionalContexts.join('\n\n'),
    };
  }
  return undefined; // no opinion → default permission flow
}

/**
 * Format a guard denial or ask reason string.
 *
 * Embeds both the guard id and the denied tool name so that session-store
 * queries can attribute denials by guard and by tool even when the session
 * store's `tool_start_name` column is NULL for pre-empted tool calls.
 *
 * Format: `[copilot-guards/<id> | tool:<toolName>] <reason>`
 *
 * Chronicle query pattern:
 *   WHERE tool_complete_result_content ILIKE '%[copilot-guards/%'
 *   -- extract guard id: regexp_extract(..., '\[copilot-guards/([^|]+) \|', 1)
 *   -- extract tool:     regexp_extract(..., '\| tool:([^\]]+)\]', 1)
 */
function formatDeny(id, toolName, reason) {
  return `${formatGuardMarker(id, toolName)} ${reason}`;
}

function formatPrAggregate(denies, asks, toolName) {
  const header =
    denies.length > 0
      ? 'PR preflight failed. Fix the following before retrying create_pull_request:'
      : 'PR preflight needs confirmation before continuing with create_pull_request:';
  const lines = [header];
  for (const d of denies) {
    lines.push(`  ❌ ${formatGuardMarker(d.id, toolName)} ${d.reason}`);
  }
  for (const a of asks) {
    lines.push(`  ❓ ${formatGuardMarker(a.id, toolName)} ${a.reason}`);
  }
  lines.push('');
  lines.push(
    'To bypass a specific guard (legitimate edge cases only): set COPILOT_GUARDS_DISABLE=<guard-id> in the environment.',
  );
  return lines.join('\n');
}

function formatGuardMarker(id, toolName) {
  return `[copilot-guards/${id} | tool:${toolName}]`;
}

async function safeLog(ctx, msg, opts) {
  try {
    await ctx.log?.(msg, opts);
  } catch {
    /* never let logging break the dispatcher */
  }
}
