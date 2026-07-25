/**
 * Context-efficiency metrics for a trial.
 *
 * Turns and output tokens say how much the agent *produced*. They say nothing
 * about how much context it *burned* getting there — and context burn is what
 * forces compaction, which is expensive (a re-summarisation call) and lossy
 * (the agent re-derives what it already knew). An arm that reaches green in
 * fewer turns while doubling context burn has not obviously won.
 *
 * The headless `--output-format json` transcript carries no context data, but
 * the session-state event log does. That is the same log `agent-perf-panel`
 * reads, so the lab and the panel agree by construction.
 *
 * Field names below were read off a real event log, not inferred:
 * - `session.compaction_complete` → `preCompactionTokens`, `compactionTokensUsed`, `success`
 * - `tool.execution_start`        → `toolCallId`, `toolName`
 * - `tool.execution_complete`     → `toolCallId`, `result.{content,detailedContent}`
 * There is no `inputTokens` field anywhere, so peak context is only observable
 * at compaction boundaries.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContextMetrics } from './types.js';

export const EMPTY_CONTEXT: ContextMetrics = {
  available: false,
  compactions: 0,
  peakContextTokens: 0,
  compactionTokensUsed: 0,
  toolResultBytes: 0,
  largestToolResultBytes: 0,
  largestToolResultName: null,
};

/** Session ids become path segments, so refuse anything path-like. */
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

export function sessionEventLogPath(sessionId: string): string {
  return join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
}

export interface RawEvent {
  type?: string;
  data?: Record<string, unknown>;
}

export function parseEvents(text: string): RawEvent[] {
  const events: RawEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as RawEvent);
    } catch {
      // A partially flushed final line is normal for a live session; skip it
      // rather than losing every metric for the session.
    }
  }
  return events;
}

function numberAt(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Bytes of a tool result that actually land in context. */
function resultByteLength(data: Record<string, unknown>): number {
  const result = data['result'];
  if (result == null) return 0;
  if (typeof result === 'string') return result.length;
  if (typeof result !== 'object') return 0;
  const content = (result as { content?: unknown }).content;
  if (typeof content === 'string') return content.length;
  try {
    return JSON.stringify(result).length;
  } catch {
    return 0;
  }
}

/**
 * Reduce a session event log to the numbers that predict context pressure.
 *
 * Tool names are carried by `tool.execution_start` and results by
 * `tool.execution_complete`, so the two are joined on `toolCallId` to attribute
 * the biggest context sink to a named tool — which is the whole point, since
 * "your context is full" is not actionable but "read_powershell returned 300KB"
 * is.
 */
export function extractContextMetrics(events: readonly RawEvent[]): ContextMetrics {
  const metrics: ContextMetrics = { ...EMPTY_CONTEXT, available: true };
  const toolNameByCallId = new Map<string, string>();

  for (const event of events) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'session.compaction_complete': {
        metrics.compactions += 1;
        metrics.compactionTokensUsed += numberAt(data, 'compactionTokensUsed');
        const pre = numberAt(data, 'preCompactionTokens');
        if (pre > metrics.peakContextTokens) metrics.peakContextTokens = pre;
        break;
      }
      case 'tool.execution_start': {
        const callId = data['toolCallId'];
        const name = data['toolName'];
        if (typeof callId === 'string' && typeof name === 'string') {
          toolNameByCallId.set(callId, name);
        }
        break;
      }
      case 'tool.execution_complete': {
        const bytes = resultByteLength(data);
        metrics.toolResultBytes += bytes;
        if (bytes > metrics.largestToolResultBytes) {
          metrics.largestToolResultBytes = bytes;
          const callId = data['toolCallId'];
          metrics.largestToolResultName =
            (typeof callId === 'string' ? toolNameByCallId.get(callId) : undefined) ?? null;
        }
        break;
      }
      default:
        break;
    }
  }

  return metrics;
}

/**
 * Read context metrics for a finished trial.
 *
 * Returns `available: false` when the event log is absent or unreadable. That
 * flag is the whole point: without it a missing log looks identical to a
 * session that used no context at all, which would make an unmeasured arm the
 * apparent winner on every context metric.
 */
export function readContextMetrics(sessionId: string | null): ContextMetrics {
  if (!sessionId || !isSafeSessionId(sessionId)) return { ...EMPTY_CONTEXT };
  const path = sessionEventLogPath(sessionId);
  if (!existsSync(path)) return { ...EMPTY_CONTEXT };
  try {
    return extractContextMetrics(parseEvents(readFileSync(path, 'utf8')));
  } catch {
    return { ...EMPTY_CONTEXT };
  }
}
