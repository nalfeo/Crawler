// Analyzer: parse a single session's events.jsonl into a compact, panel-ready summary.
//
// Source: ~/.copilot/session-state/<sessionId>/events.jsonl (one JSON event per line).
//
// Output shape is stable across schema drift — we only touch fields we understand
// and are defensive about missing pieces. Cached in-process by (sessionId, mtime).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

/** Ephemeral event types that add no perf value; we skip parsing them. */
const IGNORED_TYPES = new Set([
  'session.background_tasks_changed',
  'pending_messages.modified',
  'session.mcp_server_status_changed',
  'session.tools_updated',
  'session.mcp_servers_loaded',
  'session.title_changed',
  'session.todos_changed',
  'assistant.message_start',
]);

/** Best-effort per-model context-window budgets (tokens). Used only for the
 *  "% of window" line. Exact entries win; anything not enumerated here falls
 *  back to the documented per-family prefix (see `resolveContextWindow`). */
const MODEL_CONTEXT_WINDOW = {
  'claude-opus-4.8': 200_000,
  'claude-opus-4.7': 200_000,
  'claude-opus-4.6': 200_000,
  'claude-sonnet-5': 200_000,
  'claude-sonnet-4.6': 200_000,
  // claude-sonnet-4.5 removed: deprecated by GitHub on 2026-05-06
  'claude-haiku-4.5': 200_000,
  'gpt-5.5': 400_000,
  'gpt-5.4': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5-mini': 400_000,
  'gemini-3.1-pro-preview': 1_000_000,
  'gemini-3.5-flash': 1_000_000,
  'gemini-3.6-flash': 1_000_000,
  'mai-code-1-flash-picker': 200_000,
};

/** Per-family prefix fallbacks, matched in order when a model id is not an
 *  exact key above. Mirrors the budgets documented in README.md so models that
 *  aren't literally enumerated (e.g. `claude-opus-4.8`, `gpt-5.4-codex`) still
 *  resolve to a budget instead of silently dropping the whole panel. */
const MODEL_CONTEXT_WINDOW_PREFIXES = [
  ['claude-', 200_000],
  ['gpt-5', 400_000],
  ['gemini-', 1_000_000],
  ['mai-code-', 200_000],
];

/**
 * Resolve a model's context-window budget (tokens): exact map first, then the
 * documented per-family prefix. Returns null for an unknown/empty model.
 * @param {string|null|undefined} model
 * @returns {number|null}
 */
export function resolveContextWindow(model) {
  if (!model) return null;
  if (MODEL_CONTEXT_WINDOW[model]) return MODEL_CONTEXT_WINDOW[model];
  for (const [prefix, windowTokens] of MODEL_CONTEXT_WINDOW_PREFIXES) {
    if (model.startsWith(prefix)) return windowTokens;
  }
  return null;
}

const cache = new Map(); // sessionId → { mtimeMs, summary }

/**
 * A session id is interpolated into a filesystem path under
 * ~/.copilot/session-state. Reject anything containing a path separator, a
 * `..` traversal segment, or a NUL byte so a caller cannot escape that
 * directory (defense-in-depth — the loopback server is local-only, but the id
 * flows unvalidated from the HTTP route and the analyze_session action).
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSafeSessionId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('..') &&
    !id.includes('\0')
  );
}

function sessionEventsPath(sessionId) {
  return join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function toEpochMs(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Read events.jsonl for a session and compute a rich perf summary.
 * @param {string} sessionId
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<object|null>} summary, or null if the log is missing.
 */
export async function analyzeSession(sessionId, opts = {}) {
  if (!isSafeSessionId(sessionId)) return null;
  const path = sessionEventsPath(sessionId);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  const cached = cache.get(sessionId);
  if (!opts.force && cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.summary;
  }

  const summary = await parseEventsFile(path, sessionId);
  cache.set(sessionId, { mtimeMs: stat.mtimeMs, summary });
  return summary;
}

/** Reset the in-memory cache. */
export function clearAnalyzerCache() {
  cache.clear();
}

/**
 * Streaming JSONL parser + reducer. Kept self-contained so it can be reasoned
 * about in isolation — every branch produces one field on the summary.
 */
async function parseEventsFile(path, sessionId) {
  // Pending tool starts by callId, so we can pair with completes.
  /** @type {Map<string, {name:string,start:number,parentCallId?:string,argsJson?:string}>} */
  const pendingTools = new Map();
  /** @type {Array<{callId:string,name:string,start:number,end:number,durationMs:number,success:boolean|null,parentCallId?:string,turnIndex:number,agent?:string,skill?:string,errorMessage?:string,resultSizeBytes?:number}>} */
  const tools = [];

  /** @type {Map<string,{invocationId:string,type:string,start:number,end?:number,success?:boolean,durationMs?:number}>} */
  const pendingHooks = new Map();
  /** @type {Array<{invocationId:string,type:string,start:number,end:number,durationMs:number,success:boolean|null,errorMessage?:string}>} */
  const hooks = [];

  /** @type {Array<{turnIndex:number,start:number,end?:number,durationMs?:number,userPromptChars?:number,assistantChars?:number}>} */
  const turns = [];
  let currentTurn = null;
  let turnIndex = -1;

  /** @type {Array<{ts:number,model?:string,initiator?:string,inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheWriteTokens:number,cost:number,durationMs?:number,turnIndex:number}>} */
  const usages = [];

  /** @type {Array<{ts:number,by:string,tokenLimit?:number,preMessages?:number,postMessages?:number,removedMessages?:number,preTokens?:number,postTokens?:number,removedTokens?:number}>} */
  const compactions = [];
  /** @type {Array<{ts:number,type:'compaction_start'|'compaction_end'|'warning',message?:string}>} */
  const contextEvents = [];

  /** @type {Array<{name:string,start:number,end?:number,durationMs?:number,startedByCallId?:string}>} */
  const subagents = [];
  const subagentByStartCallId = new Map();

  /** @type {Array<{name:string,ts:number,callId?:string}>} */
  const skillInvocations = [];

  /** @type {Array<{ts:number,type:string,message?:string}>} */
  const errors = [];

  let selectedModel = null;
  let producer = null;
  let startedAt = 0;
  let endedAt = 0;
  let repository = null;
  let branch = null;
  let cwd = null;
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let idleCount = 0;
  let reasoningCount = 0;
  let reasoningChars = 0;
  let reasoningOpaqueBytes = 0;
  let totalAssistantChars = 0;
  let resumeCount = 0;
  let infoNotifications = 0;
  let externalToolRequests = 0;
  let externalToolCompletions = 0;
  const modelChanges = [];

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    const ev = safeParse(line);
    if (!ev || !ev.type || IGNORED_TYPES.has(ev.type)) continue;

    const ts = toEpochMs(ev.timestamp);
    if (!startedAt || ts < startedAt) startedAt = ts;
    if (ts > endedAt) endedAt = ts;
    const d = ev.data || {};

    switch (ev.type) {
      case 'session.start': {
        selectedModel = d.selectedModel || null;
        producer = d.producer || null;
        repository = d.context?.repository || null;
        branch = d.context?.branch || null;
        cwd = d.context?.cwd || null;
        break;
      }
      case 'session.model_change': {
        if (d.newModel && d.newModel !== selectedModel) {
          modelChanges.push({ ts, from: d.previousModel, to: d.newModel });
        }
        selectedModel = d.newModel || selectedModel;
        break;
      }
      case 'session.resume': {
        resumeCount += 1;
        break;
      }
      case 'assistant.turn_start': {
        turnIndex += 1;
        currentTurn = { turnIndex, start: ts };
        turns.push(currentTurn);
        break;
      }
      case 'assistant.turn_end': {
        if (currentTurn) {
          currentTurn.end = ts;
          currentTurn.durationMs = Math.max(0, ts - currentTurn.start);
          currentTurn = null;
        }
        break;
      }
      case 'user.message': {
        userMessageCount += 1;
        if (currentTurn && typeof d.content === 'string') {
          currentTurn.userPromptChars = (currentTurn.userPromptChars || 0) + d.content.length;
        }
        if (typeof d.transformedContent === 'string' && currentTurn) {
          currentTurn.transformedPromptChars =
            (currentTurn.transformedPromptChars || 0) + d.transformedContent.length;
        }
        break;
      }
      case 'assistant.message': {
        assistantMessageCount += 1;
        if (typeof d.content === 'string') totalAssistantChars += d.content.length;
        if (currentTurn && typeof d.content === 'string') {
          currentTurn.assistantChars = (currentTurn.assistantChars || 0) + d.content.length;
        }
        // Local token data lives on assistant.message rather than a distinct
        // assistant.usage event — Copilot CLI emits `outputTokens` here, and
        // occasionally `inputTokens`/`cacheReadTokens` when available.
        if (d.model || typeof d.outputTokens === 'number' || typeof d.inputTokens === 'number') {
          usages.push({
            ts,
            model: d.model || selectedModel || null,
            initiator: d.initiator || null,
            inputTokens: typeof d.inputTokens === 'number' ? d.inputTokens : 0,
            outputTokens: typeof d.outputTokens === 'number' ? d.outputTokens : 0,
            cacheReadTokens: typeof d.cacheReadTokens === 'number' ? d.cacheReadTokens : 0,
            cacheWriteTokens: typeof d.cacheWriteTokens === 'number' ? d.cacheWriteTokens : 0,
            cost: typeof d.cost === 'number' ? d.cost : 0,
            durationMs: undefined,
            turnIndex: Math.max(0, turnIndex),
            apiCallId: d.apiCallId || d.requestId || undefined,
          });
        }
        if (typeof d.reasoningText === 'string') {
          reasoningCount += 1;
          reasoningChars += d.reasoningText.length;
        }
        if (typeof d.reasoningOpaque === 'string') {
          reasoningOpaqueBytes += d.reasoningOpaque.length;
        }
        break;
      }
      case 'assistant.reasoning': {
        // Kept for schema compatibility even though current CLI folds reasoning
        // into assistant.message.
        reasoningCount += 1;
        if (typeof d.text === 'string') reasoningChars += d.text.length;
        else if (typeof d.reasoning === 'string') reasoningChars += d.reasoning.length;
        break;
      }
      case 'assistant.usage': {
        usages.push({
          ts,
          model: d.model || selectedModel || null,
          initiator: d.initiator || null,
          inputTokens: d.inputTokens || 0,
          outputTokens: d.outputTokens || 0,
          cacheReadTokens: d.cacheReadTokens || 0,
          cacheWriteTokens: d.cacheWriteTokens || 0,
          cost: d.cost || 0,
          durationMs: d.duration || undefined,
          turnIndex: Math.max(0, turnIndex),
        });
        break;
      }
      case 'tool.execution_start': {
        const callId = d.toolCallId || d.callId;
        if (!callId) break;
        pendingTools.set(callId, {
          name: d.toolName || 'unknown',
          start: ts,
          parentCallId: d.parentToolCallId || undefined,
          model: d.model || null,
          argsJson: d.arguments ? JSON.stringify(d.arguments).slice(0, 400) : undefined,
        });
        break;
      }
      case 'tool.execution_complete': {
        const callId = d.toolCallId || d.callId;
        if (!callId) break;
        const start = pendingTools.get(callId);
        if (!start) break;
        pendingTools.delete(callId);
        const resultLen =
          typeof d.result === 'string'
            ? d.result.length
            : d.result?.content
              ? String(d.result.content).length
              : d.result
                ? JSON.stringify(d.result).length
                : 0;
        tools.push({
          callId,
          name: start.name,
          start: start.start,
          end: ts,
          durationMs: Math.max(0, ts - start.start),
          success: typeof d.success === 'boolean' ? d.success : null,
          parentCallId: start.parentCallId,
          turnIndex: Math.max(0, turnIndex),
          agent: undefined,
          model: start.model || undefined,
          argsPreview: start.argsJson,
          errorMessage: d.error || d.errorMessage || undefined,
          resultSizeBytes: resultLen || undefined,
        });
        break;
      }
      case 'skill.invoked': {
        skillInvocations.push({
          name: d.name || 'skill',
          ts,
          path: d.path || undefined,
          contentBytes: typeof d.content === 'string' ? d.content.length : undefined,
        });
        break;
      }
      case 'hook.start': {
        const id = d.hookInvocationId || d.invocationId;
        if (!id) break;
        pendingHooks.set(id, { invocationId: id, type: d.hookType || 'hook', start: ts });
        break;
      }
      case 'hook.end': {
        const id = d.hookInvocationId || d.invocationId;
        if (!id) break;
        const start = pendingHooks.get(id);
        if (!start) break;
        pendingHooks.delete(id);
        hooks.push({
          invocationId: id,
          type: start.type,
          start: start.start,
          end: ts,
          durationMs: Math.max(0, ts - start.start),
          success: typeof d.success === 'boolean' ? d.success : null,
          errorMessage: d.errorMessage || undefined,
        });
        break;
      }
      case 'session.compaction_start': {
        // Rich pre-compaction breakdown: system / conversation / toolDefinitions.
        contextEvents.push({
          ts,
          type: 'compaction_start',
          systemTokens: d.systemTokens || undefined,
          conversationTokens: d.conversationTokens || undefined,
          toolDefinitionsTokens: d.toolDefinitionsTokens || undefined,
          totalTokens:
            (d.systemTokens || 0) + (d.conversationTokens || 0) + (d.toolDefinitionsTokens || 0) ||
            undefined,
        });
        break;
      }
      case 'session.compaction_complete': {
        compactions.push({
          ts,
          by: 'auto',
          preTokens: d.preCompactionTokens || undefined,
          preMessages: d.preCompactionMessagesLength || undefined,
          summaryChars: typeof d.summaryContent === 'string' ? d.summaryContent.length : undefined,
          success: d.success !== false,
        });
        contextEvents.push({ ts, type: 'compaction_end' });
        break;
      }
      case 'session.usage_info': {
        if (d.truncationTokenLimit || d.truncationRemovedTokens) {
          compactions.push({
            ts,
            by: d.truncationPerformedBy || 'unknown',
            tokenLimit: d.truncationTokenLimit || undefined,
            preMessages: d.truncationPreMessages || undefined,
            postMessages: d.truncationPostMessages || undefined,
            removedMessages: d.truncationRemovedMessages || undefined,
            preTokens: d.truncationPreTokens || undefined,
            postTokens: d.truncationPostTokens || undefined,
            removedTokens: d.truncationRemovedTokens || undefined,
          });
        }
        break;
      }
      case 'session.warning': {
        contextEvents.push({ ts, type: 'warning', message: d.message });
        break;
      }
      case 'session.info': {
        // Guard-load / MCP status notifications — cheap to keep as a rolled-up count.
        infoNotifications += 1;
        break;
      }
      case 'agent.selected':
      case 'agent.started': {
        const name = d.name || d.displayName;
        if (!name) break;
        const entry = {
          name,
          start: ts,
          startedByCallId: d.toolCallId || undefined,
        };
        subagents.push(entry);
        if (d.toolCallId) subagentByStartCallId.set(d.toolCallId, entry);
        break;
      }
      case 'agent.completed':
      case 'agent.failed': {
        const cid = d.toolCallId;
        if (cid && subagentByStartCallId.has(cid)) {
          const entry = subagentByStartCallId.get(cid);
          entry.end = ts;
          entry.durationMs = Math.max(0, ts - entry.start);
        } else if (subagents.length) {
          const open = [...subagents].reverse().find((s) => !s.end);
          if (open) {
            open.end = ts;
            open.durationMs = Math.max(0, ts - open.start);
          }
        }
        if (ev.type === 'agent.failed') {
          errors.push({ ts, type: 'agent.failed', message: d.error || d.errorMessage });
        }
        break;
      }
      case 'session.idle': {
        idleCount += 1;
        break;
      }
      case 'session.error':
      case 'assistant.turn_error': {
        errors.push({ ts, type: ev.type, message: d.message || d.errorMessage });
        break;
      }
      case 'abort': {
        errors.push({ ts, type: 'abort', message: d.reason });
        break;
      }
      case 'external_tool.requested': {
        externalToolRequests += 1;
        break;
      }
      case 'external_tool.completed': {
        externalToolCompletions += 1;
        break;
      }
      default:
        break;
    }
  }

  // Any tool starts left dangling — probably in-flight when the log ended.
  for (const [callId, start] of pendingTools.entries()) {
    tools.push({
      callId,
      name: start.name,
      start: start.start,
      end: endedAt,
      durationMs: Math.max(0, endedAt - start.start),
      success: null,
      parentCallId: start.parentCallId,
      turnIndex: Math.max(0, turnIndex),
      errorMessage: 'incomplete',
    });
  }
  for (const [id, start] of pendingHooks.entries()) {
    hooks.push({
      invocationId: id,
      type: start.type,
      start: start.start,
      end: endedAt,
      durationMs: Math.max(0, endedAt - start.start),
      success: null,
      errorMessage: 'incomplete',
    });
  }

  return buildSummary({
    sessionId,
    selectedModel,
    producer,
    startedAt,
    endedAt,
    repository,
    branch,
    cwd,
    turns,
    tools,
    hooks,
    usages,
    compactions,
    contextEvents,
    subagents,
    skillInvocations,
    errors,
    userMessageCount,
    assistantMessageCount,
    idleCount,
    reasoningCount,
    reasoningChars,
    reasoningOpaqueBytes,
    totalAssistantChars,
    resumeCount,
    infoNotifications,
    externalToolRequests,
    externalToolCompletions,
    modelChanges,
  });
}

/** Convert raw per-event arrays into a normalized summary shape. */
export function buildSummary(raw) {
  const walltimeMs = Math.max(0, raw.endedAt - raw.startedAt);
  const toolTimeMs = raw.tools.reduce((s, t) => s + t.durationMs, 0);
  const hookTimeMs = raw.hooks.reduce((s, h) => s + h.durationMs, 0);
  const turnTimeMs = raw.turns.reduce((s, t) => s + (t.durationMs || 0), 0);
  const parallelStats = computeParallelStats(raw.tools);

  // Long poles: top-20 individual tool calls by duration.
  const longestTools = [...raw.tools]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 20)
    .map(sanitizeToolForClient);

  // Aggregate by tool name.
  const byToolName = new Map();
  for (const t of raw.tools) {
    const row = byToolName.get(t.name) || {
      name: t.name,
      count: 0,
      totalMs: 0,
      failures: 0,
      p50: 0,
      p95: 0,
      max: 0,
      // Context cost, not just wall-clock cost. A tool can be fast and still be
      // the reason a session compacts.
      totalResultBytes: 0,
      maxResultBytes: 0,
      _durations: [],
    };
    row.count += 1;
    row.totalMs += t.durationMs;
    row.max = Math.max(row.max, t.durationMs);
    const bytes = t.resultSizeBytes || 0;
    row.totalResultBytes += bytes;
    row.maxResultBytes = Math.max(row.maxResultBytes, bytes);
    if (t.success === false) row.failures += 1;
    row._durations.push(t.durationMs);
    byToolName.set(t.name, row);
  }
  const toolAggregates = [...byToolName.values()]
    .map((r) => {
      const sorted = r._durations.sort((a, b) => a - b);
      const p = (frac) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * frac))] || 0;
      return {
        name: r.name,
        count: r.count,
        totalMs: r.totalMs,
        avgMs: Math.round(r.totalMs / r.count),
        p50: p(0.5),
        p95: p(0.95),
        max: r.max,
        failures: r.failures,
        totalResultBytes: r.totalResultBytes,
        avgResultBytes: Math.round(r.totalResultBytes / r.count),
        maxResultBytes: r.maxResultBytes,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);

  // Aggregate by hook type.
  const hookByType = new Map();
  for (const h of raw.hooks) {
    const row = hookByType.get(h.type) || { type: h.type, count: 0, totalMs: 0, failures: 0 };
    row.count += 1;
    row.totalMs += h.durationMs;
    if (h.success === false) row.failures += 1;
    hookByType.set(h.type, row);
  }
  const hookAggregates = [...hookByType.values()].sort((a, b) => b.totalMs - a.totalMs);

  // Token accounting.
  const totalTokens = raw.usages.reduce(
    (acc, u) => {
      acc.input += u.inputTokens;
      acc.output += u.outputTokens;
      acc.cacheRead += u.cacheReadTokens;
      acc.cacheWrite += u.cacheWriteTokens;
      acc.cost += u.cost;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );

  // Per-model breakdown.
  const byModel = new Map();
  for (const u of raw.usages) {
    const key = u.model || 'unknown';
    const row = byModel.get(key) || {
      model: key,
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    };
    row.callCount += 1;
    row.inputTokens += u.inputTokens;
    row.outputTokens += u.outputTokens;
    row.cacheReadTokens += u.cacheReadTokens;
    row.cacheWriteTokens += u.cacheWriteTokens;
    row.cost += u.cost;
    byModel.set(key, row);
  }
  const modelBreakdown = [...byModel.values()].sort((a, b) => b.cost - a.cost);

  // Turn-level rollup: tool time, hook time, token in/out, model idle gap.
  const turnRollup = raw.turns.map((t) => {
    const toolsInTurn = raw.tools.filter((x) => x.turnIndex === t.turnIndex);
    const usageInTurn = raw.usages.filter((x) => x.turnIndex === t.turnIndex);
    const toolMs = toolsInTurn.reduce((s, x) => s + x.durationMs, 0);
    const hookMs = raw.hooks
      .filter((h) => h.start >= t.start && h.end <= (t.end || raw.endedAt))
      .reduce((s, h) => s + h.durationMs, 0);
    return {
      turnIndex: t.turnIndex,
      start: t.start,
      end: t.end || raw.endedAt,
      durationMs: t.durationMs || Math.max(0, (t.end || raw.endedAt) - t.start),
      toolMs,
      hookMs,
      toolCount: toolsInTurn.length,
      apiCallCount: usageInTurn.length,
      inputTokens: usageInTurn.reduce((s, u) => s + u.inputTokens, 0),
      outputTokens: usageInTurn.reduce((s, u) => s + u.outputTokens, 0),
      cost: usageInTurn.reduce((s, u) => s + u.cost, 0),
      userPromptChars: t.userPromptChars || 0,
      assistantChars: t.assistantChars || 0,
    };
  });

  // Best model for budget lookup: prefer per-usage model if selected is 'auto'.
  const budgetModel =
    raw.selectedModel && raw.selectedModel !== 'auto'
      ? raw.selectedModel
      : raw.usages.find((u) => u.model && u.model !== 'auto')?.model || raw.selectedModel;
  const modelBudget = resolveContextWindow(budgetModel);

  // Peak context tokens observed at compaction points — the most reliable
  // local signal for context-window pressure.
  const peakContextTokens = raw.compactions.reduce(
    (peak, c) => Math.max(peak, c.preTokens || 0),
    0,
  );

  return {
    sessionId: raw.sessionId,
    repository: raw.repository,
    branch: raw.branch,
    cwd: raw.cwd,
    producer: raw.producer,
    selectedModel: raw.selectedModel,
    budgetModel,
    modelContextBudget: modelBudget,
    modelChanges: raw.modelChanges,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    walltimeMs,
    // High-level rollup.
    totals: {
      turns: raw.turns.length,
      userMessages: raw.userMessageCount,
      assistantMessages: raw.assistantMessageCount,
      idleTransitions: raw.idleCount,
      resumes: raw.resumeCount,
      reasoningEvents: raw.reasoningCount,
      reasoningChars: raw.reasoningChars,
      reasoningOpaqueBytes: raw.reasoningOpaqueBytes,
      assistantChars: raw.totalAssistantChars,
      apiCalls: raw.usages.length,
      toolCalls: raw.tools.length,
      hookInvocations: raw.hooks.length,
      subagentSpawns: raw.subagents.length,
      skillInvocations: raw.skillInvocations.length,
      compactions: raw.compactions.length,
      externalToolRequests: raw.externalToolRequests,
      externalToolCompletions: raw.externalToolCompletions,
      infoNotifications: raw.infoNotifications,
      errors: raw.errors.length,
      toolTimeMs,
      hookTimeMs,
      turnTimeMs,
      idleTimeMs: Math.max(0, walltimeMs - turnTimeMs),
      parallelToolTimeMs: parallelStats.parallelToolTimeMs,
      serialToolTimeMs: parallelStats.serialToolTimeMs,
      parallelismRatio: parallelStats.parallelismRatio,
      maxParallelism: parallelStats.maxParallelism,
      tokens: totalTokens,
      peakContextTokens: peakContextTokens || undefined,
    },
    tools: raw.tools.map(sanitizeToolForClient),
    hooks: raw.hooks,
    longestTools,
    toolAggregates,
    // Same rows, ranked by context cost instead of latency. Time-ranked and
    // context-ranked orders differ sharply (a 200ms grep can return 300KB),
    // and context cost is what drives compaction.
    contextSinks: [...toolAggregates]
      .filter((t) => t.totalResultBytes > 0)
      .sort((a, b) => b.totalResultBytes - a.totalResultBytes)
      .slice(0, 10),
    hookAggregates,
    usages: raw.usages,
    modelBreakdown,
    compactions: raw.compactions,
    contextEvents: raw.contextEvents,
    subagents: raw.subagents,
    skillInvocations: raw.skillInvocations,
    errors: raw.errors,
    turns: turnRollup,
    waterfall: buildWaterfall({
      tools: raw.tools,
      turns: turnRollup,
      startedAt: raw.startedAt,
      endedAt: raw.endedAt,
      compactions: raw.compactions,
      contextEvents: raw.contextEvents,
      budgetTokens: modelBudget,
    }),
  };
}

function sanitizeToolForClient(t) {
  // Drop nothing — but keep this hook here so we can trim heavy fields later
  // if the payload gets large.
  return t;
}

/**
 * Sweep-line over tool intervals to compute:
 *   - total wall-clock time during which >=2 tools were running (parallel)
 *   - total wall-clock time during which exactly 1 tool was running (serial)
 *   - the peak concurrency observed
 *   - parallelismRatio = parallelToolTimeMs / (parallelToolTimeMs + serialToolTimeMs)
 */
export function computeParallelStats(tools) {
  if (tools.length === 0) {
    return { parallelToolTimeMs: 0, serialToolTimeMs: 0, parallelismRatio: 0, maxParallelism: 0 };
  }
  /** @type {Array<[number, 1|-1]>} */
  const events = [];
  for (const t of tools) {
    events.push([t.start, 1]);
    events.push([t.end, -1]);
  }
  // Sort by timestamp; on ties process end (-1) before start (+1) so that
  // adjacent, non-overlapping intervals (e.g. [0,10] then [10,20]) never
  // register a transient overlap and overstate maxParallelism.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let last = events[0][0];
  let parallelMs = 0;
  let serialMs = 0;
  let peak = 0;
  for (const [ts, delta] of events) {
    const dt = ts - last;
    if (dt > 0) {
      if (active >= 2) parallelMs += dt;
      else if (active === 1) serialMs += dt;
    }
    active += delta;
    if (active > peak) peak = active;
    last = ts;
  }
  const denom = parallelMs + serialMs;
  return {
    parallelToolTimeMs: parallelMs,
    serialToolTimeMs: serialMs,
    parallelismRatio: denom > 0 ? parallelMs / denom : 0,
    maxParallelism: peak,
  };
}

function clampNum(v, lo, hi) {
  // Non-finite inputs (NaN/Infinity/undefined) fall back to the low bound so a
  // single bad timestamp can never poison layout math into NaN%.
  const n = Number.isFinite(v) ? v : lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Build a TRUE waterfall layout: a single shared wall-clock time axis spanning
 * [startedAt, endedAt], with ONE lane per tool call ordered by real start time.
 * Each lane is positioned by its actual start / duration on that axis, so serial
 * calls step down-and-right and parallel calls stack as overlapping bars — the
 * classic cascade. This is deliberately axis-shared (unlike the old per-turn
 * re-normalized strips, which had no common time scale and were not a waterfall).
 *
 * Positions are returned as percentages of the total span so the client can lay
 * them out with plain CSS and stay pixel-accurate at any panel width.
 *
 * @param {{tools:Array, turns?:Array, startedAt:number, endedAt:number}} input
 * @param {{maxRows?:number}} [opts]
 */
export function buildWaterfall(input, opts = {}) {
  const tools = Array.isArray(input?.tools) ? input.tools : [];
  const turns = Array.isArray(input?.turns) ? input.turns : [];
  const maxRows = opts.maxRows ?? 2000;

  const t0 = Number.isFinite(input?.startedAt) ? input.startedAt : 0;
  const rawT1 = Number.isFinite(input?.endedAt) ? input.endedAt : t0;

  // Canonicalize each tool's start/end up front. A single NaN/Infinity/undefined
  // timestamp would otherwise poison the sort comparator and the pct math, so we
  // resolve every interval to finite numbers with end >= start before using them.
  const canon = tools.map((x) => {
    const start = Number.isFinite(x?.start) ? x.start : t0;
    const endRaw = Number.isFinite(x?.end) ? x.end : start;
    return { tool: x, start, end: Math.max(start, endRaw) };
  });

  // Guard against clock skew / open intervals so the axis always covers every bar.
  // Only finite ends may extend the axis (canon already guaranteed finiteness).
  let t1 = Math.max(rawT1, t0);
  for (const c of canon) t1 = Math.max(t1, c.end);

  // actualSpanMs is the real elapsed time (may be 0 for an instant session) and is
  // what we return/display. layoutSpanMs is only ever used as the pct denominator,
  // clamped to >=1 so we never divide by zero.
  const actualSpanMs = Math.max(0, t1 - t0);
  const layoutSpanMs = Math.max(1, actualSpanMs);

  const sorted = [...canon].sort((a, b) => a.start - b.start || a.end - b.end);
  const totalRows = sorted.length;
  const shown = sorted.slice(0, maxRows);
  const rows = shown.map((c) => {
    const x = c.tool;
    const start = clampNum(c.start, t0, t1);
    const end = clampNum(c.end, start, t1);
    return {
      callId: x.callId,
      name: x.name,
      turnIndex: x.turnIndex ?? 0,
      success: x.success === false ? false : x.success === true ? true : null,
      durationMs: Number.isFinite(x.durationMs) ? x.durationMs : Math.max(0, end - start),
      startOffsetMs: Math.max(0, start - t0),
      leftPct: clampNum(((start - t0) / layoutSpanMs) * 100, 0, 100),
      widthPct: clampNum((Math.max(0, end - start) / layoutSpanMs) * 100, 0, 100),
    };
  });

  const turnBands = turns.map((t) => {
    const start = clampNum(t.start ?? t0, t0, t1);
    const end = clampNum(t.end ?? t1, start, t1);
    return {
      turnIndex: t.turnIndex ?? 0,
      leftPct: clampNum(((start - t0) / layoutSpanMs) * 100, 0, 100),
      widthPct: clampNum((Math.max(0, end - start) / layoutSpanMs) * 100, 0, 100),
      startOffsetMs: Math.max(0, start - t0),
      durationMs: Number.isFinite(t.durationMs) ? t.durationMs : Math.max(0, end - start),
      userPromptChars: t.userPromptChars ?? 0,
      toolCount: t.toolCount ?? 0,
    };
  });

  const TICK_COUNT = 6;
  const ticks = [];
  for (let i = 0; i <= TICK_COUNT; i++) {
    ticks.push({ pct: (i / TICK_COUNT) * 100, ms: (i / TICK_COUNT) * actualSpanMs });
  }

  // Context-window pressure, resolved on the SAME axis (t0/t1/layoutSpanMs) so its
  // markers line up horizontally with the tool lanes below.
  const context = buildContextPoints(
    {
      compactions: input?.compactions,
      contextEvents: input?.contextEvents,
      budgetTokens: input?.budgetTokens,
    },
    { t0, t1, layoutSpanMs },
  );

  return {
    axis: 'wallclock',
    startedAt: t0,
    endedAt: t1,
    spanMs: actualSpanMs,
    totalRows,
    truncated: totalRows > shown.length,
    rows,
    turnBands,
    ticks,
    context,
  };
}

/**
 * Build the context-window "pressure" series for the waterfall's context strip.
 *
 * HONESTY NOTE: the Copilot CLI event log does NOT record a running context size.
 * Per-call input/cache token counts are 0 in the logs; the only real samples of
 * how full the context window got are the pre-compaction totals captured when a
 * compaction fires (`compactions[].preTokens`). This function therefore returns
 * DISCRETE high-water-mark points (one per compaction) plus the configured budget
 * — never an interpolated/continuous line. The renderer draws stems+dots, not a
 * connecting trend line, so nothing implies measurement between samples.
 *
 * Alignment: points are positioned on the caller-supplied axis (t0/t1/layoutSpanMs),
 * which is the exact axis the waterfall lanes use, so a compaction dot sits above
 * the lane that was running when it happened.
 *
 * @param {{compactions?:Array, contextEvents?:Array, budgetTokens?:number}} input
 * @param {{t0:number, t1:number, layoutSpanMs:number}} axis
 */
export function buildContextPoints(input, axis) {
  const compactions = Array.isArray(input?.compactions) ? input.compactions : [];
  const contextEvents = Array.isArray(input?.contextEvents) ? input.contextEvents : [];
  const t0 = Number.isFinite(axis?.t0) ? axis.t0 : 0;
  const t1 = Number.isFinite(axis?.t1) ? axis.t1 : t0;
  const layoutSpanMs =
    Number.isFinite(axis?.layoutSpanMs) && axis.layoutSpanMs > 0 ? axis.layoutSpanMs : 1;
  const budgetTokens =
    Number.isFinite(input?.budgetTokens) && input.budgetTokens > 0 ? input.budgetTokens : null;

  // Breakdown pairing (per plan review). contextEvents is a MIXED stream
  // (compaction_start / compaction_end / warning) and compactions mixes
  // auto-compactions with truncations, so the two arrays are NOT index-aligned.
  // Only `session.compaction_complete` (by:'auto') is preceded by a
  // compaction_start carrying the {system/conversation/toolDefinitions} breakdown;
  // truncations (`session.usage_info`, by:!'auto') never emit one. So ONLY auto-
  // compactions may consume a start (FIFO: each start consumed at most once; the
  // last start at-or-before an auto-compaction is that compaction's cycle start).
  // Truncations — and any auto-compaction with no preceding unconsumed start — get
  // no breakdown. Gating consumption on by==='auto' is essential: otherwise a
  // truncation interleaved between a start and its owning auto-compaction would
  // greedily steal that start's breakdown and leave the real auto-compaction null.
  const starts = contextEvents
    .filter((e) => e && e.type === 'compaction_start' && Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts);

  const usable = [];
  for (const c of compactions) {
    const tokens = Number.isFinite(c?.preTokens) ? c.preTokens : null;
    const ts = Number.isFinite(c?.ts) ? c.ts : null;
    if (tokens == null || tokens <= 0 || ts == null) continue; // no usable sample
    usable.push({ ts, tokens, by: typeof c?.by === 'string' ? c.by : null });
  }
  usable.sort((a, b) => a.ts - b.ts);

  let sp = 0; // FIFO pointer into starts
  let peakTokens = 0;
  let breakdownCount = 0;
  const points = [];
  for (const u of usable) {
    let cand = null;
    // Only auto-compactions consume/pair with a compaction_start. Truncations are
    // skipped entirely (no consumption) so they can neither steal nor be assigned
    // a breakdown that structurally isn't theirs.
    if (u.by === 'auto') {
      while (sp < starts.length && starts[sp].ts <= u.ts) {
        cand = starts[sp];
        sp++;
      }
    }
    const breakdown = cand
      ? {
          systemTokens: Number.isFinite(cand.systemTokens) ? cand.systemTokens : null,
          conversationTokens: Number.isFinite(cand.conversationTokens)
            ? cand.conversationTokens
            : null,
          toolDefinitionsTokens: Number.isFinite(cand.toolDefinitionsTokens)
            ? cand.toolDefinitionsTokens
            : null,
        }
      : null;
    if (breakdown) breakdownCount++;
    peakTokens = Math.max(peakTokens, u.tokens);
    points.push({
      ts: u.ts,
      tMs: Math.max(0, u.ts - t0),
      tokens: u.tokens,
      by: u.by,
      _rawXPct: ((u.ts - t0) / layoutSpanMs) * 100,
      breakdown,
    });
  }

  // Vertical scale: the taller of the observed peak or the budget, so both the
  // budget line and an over-budget peak remain visible. Falls back to 1 to avoid
  // divide-by-zero when there is neither.
  const maxTokens = Math.max(peakTokens, budgetTokens || 0) || 1;

  const finalized = points.map((p) => {
    const offAxis = p._rawXPct < 0 || p._rawXPct > 100;
    return {
      tMs: p.tMs,
      xPct: clampNum(p._rawXPct, 0, 100),
      offAxis,
      tokens: p.tokens,
      tokensPct: clampNum((p.tokens / maxTokens) * 100, 0, 100),
      budgetPct: budgetTokens ? (p.tokens / budgetTokens) * 100 : null,
      overBudget: budgetTokens ? p.tokens > budgetTokens : false,
      by: p.by,
      breakdown: p.breakdown,
    };
  });

  return {
    hasData: finalized.length > 0,
    budgetTokens,
    peakTokens,
    maxTokens,
    breakdownCount,
    offAxisCount: finalized.filter((p) => p.offAxis).length,
    points: finalized,
  };
}
