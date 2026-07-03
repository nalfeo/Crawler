// aggregator: cross-session rollups for the "aggregate over date range" view.
//
// Reuses analyzer summaries; caches per-session summaries via analyzer's own
// (sessionId, mtime) cache, so calling this repeatedly is cheap.

import { analyzeSession } from './analyzer.mjs';
import { listSessions } from './sessions-db.mjs';

/**
 * Aggregate a set of sessions matching the filter.
 * @param {{ repository?: string, sinceIso?: string, untilIso?: string, limit?: number }} filter
 */
export async function aggregate(filter) {
  const sessions = listSessions({ ...filter, limit: filter.limit || 200 });
  const perSession = [];
  const errors = [];
  // Global tool + model aggregates are built in the same pass as perSession so
  // each session is analyzed once and every failure is recorded consistently.
  const toolTotals = new Map();
  const perModelTotals = new Map();

  for (const s of sessions) {
    if (!s.hasEventLog) continue;
    try {
      const summary = await analyzeSession(s.id);
      if (!summary) continue;
      perSession.push({
        sessionId: s.id,
        summaryText: s.summary,
        branch: s.branch,
        model: summary.budgetModel || summary.selectedModel || 'unknown',
        walltimeMs: summary.walltimeMs,
        toolTimeMs: summary.totals.toolTimeMs,
        hookTimeMs: summary.totals.hookTimeMs,
        turnTimeMs: summary.totals.turnTimeMs,
        idleTimeMs: summary.totals.idleTimeMs,
        turns: summary.totals.turns,
        toolCalls: summary.totals.toolCalls,
        apiCalls: summary.totals.apiCalls,
        outputTokens: summary.totals.tokens.output,
        inputTokens: summary.totals.tokens.input,
        cacheReadTokens: summary.totals.tokens.cacheRead,
        parallelismRatio: summary.totals.parallelismRatio,
        maxParallelism: summary.totals.maxParallelism,
        peakContextTokens: summary.totals.peakContextTokens || 0,
        compactions: summary.totals.compactions,
        skillInvocations: summary.totals.skillInvocations,
        subagentSpawns: summary.totals.subagentSpawns,
        errors: summary.totals.errors,
        reasoningChars: summary.totals.reasoningChars,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
      });
      for (const t of summary.toolAggregates) {
        const row = toolTotals.get(t.name) || {
          name: t.name,
          count: 0,
          totalMs: 0,
          failures: 0,
          maxMs: 0,
        };
        row.count += t.count;
        row.totalMs += t.totalMs;
        row.failures += t.failures;
        row.maxMs = Math.max(row.maxMs, t.max);
        toolTotals.set(t.name, row);
      }
      for (const m of summary.modelBreakdown) {
        const row = perModelTotals.get(m.model) || {
          model: m.model,
          sessions: 0,
          apiCalls: 0,
          outputTokens: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cost: 0,
        };
        row.sessions += 1;
        row.apiCalls += m.callCount;
        row.outputTokens += m.outputTokens;
        row.inputTokens += m.inputTokens;
        row.cacheReadTokens += m.cacheReadTokens;
        row.cost += m.cost;
        perModelTotals.set(m.model, row);
      }
    } catch (e) {
      errors.push({ sessionId: s.id, error: String(e?.message || e) });
    }
  }

  const toolAggregate = [...toolTotals.values()]
    .map((r) => ({ ...r, avgMs: Math.round(r.totalMs / Math.max(1, r.count)) }))
    .sort((a, b) => b.totalMs - a.totalMs);

  const modelAggregate = [...perModelTotals.values()].sort(
    (a, b) => b.outputTokens - a.outputTokens,
  );

  const totals = sumSessionTotals(perSession);

  return {
    filter,
    totals,
    sessions: perSession,
    toolAggregate,
    modelAggregate,
    errors,
  };
}

/**
 * Sum the numeric per-session rows into a single cross-session totals object.
 * Pure and side-effect free — exported so the reduction can be unit-tested
 * without touching the SQLite store or the filesystem.
 * @param {Array<object>} perSession
 */
export function sumSessionTotals(perSession) {
  return perSession.reduce(
    (acc, s) => {
      acc.sessions += 1;
      acc.walltimeMs += s.walltimeMs;
      acc.toolTimeMs += s.toolTimeMs;
      acc.hookTimeMs += s.hookTimeMs;
      acc.turnTimeMs += s.turnTimeMs;
      acc.idleTimeMs += s.idleTimeMs;
      acc.toolCalls += s.toolCalls;
      acc.turns += s.turns;
      acc.apiCalls += s.apiCalls;
      acc.outputTokens += s.outputTokens;
      acc.inputTokens += s.inputTokens;
      acc.cacheReadTokens += s.cacheReadTokens;
      acc.compactions += s.compactions;
      acc.skillInvocations += s.skillInvocations;
      acc.subagentSpawns += s.subagentSpawns;
      acc.errors += s.errors;
      acc.reasoningChars += s.reasoningChars;
      return acc;
    },
    {
      sessions: 0,
      walltimeMs: 0,
      toolTimeMs: 0,
      hookTimeMs: 0,
      turnTimeMs: 0,
      idleTimeMs: 0,
      toolCalls: 0,
      turns: 0,
      apiCalls: 0,
      outputTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      compactions: 0,
      skillInvocations: 0,
      subagentSpawns: 0,
      errors: 0,
      reasoningChars: 0,
    },
  );
}
