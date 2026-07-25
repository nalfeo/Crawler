import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveContextWindow,
  computeParallelStats,
  buildSummary,
  buildWaterfall,
  buildContextPoints,
  isSafeSessionId,
} from '../analyzer.mjs';
import { renderHtml } from '../renderer.mjs';

// --- isSafeSessionId ------------------------------------------------------

test('isSafeSessionId accepts normal session ids', () => {
  assert.equal(isSafeSessionId('4759f218-3740-48c9-836a-adefe575f059'), true);
  assert.equal(isSafeSessionId('abc123'), true);
});

test('isSafeSessionId rejects path traversal and separators', () => {
  assert.equal(isSafeSessionId('../secrets'), false);
  assert.equal(isSafeSessionId('a/b'), false);
  assert.equal(isSafeSessionId('a\\b'), false);
  assert.equal(isSafeSessionId('..'), false);
  assert.equal(isSafeSessionId('a\0b'), false);
});

test('isSafeSessionId rejects empty and non-string input', () => {
  assert.equal(isSafeSessionId(''), false);
  assert.equal(isSafeSessionId(null), false);
  assert.equal(isSafeSessionId(undefined), false);
  assert.equal(isSafeSessionId(42), false);
});

// --- resolveContextWindow -------------------------------------------------

test('resolveContextWindow returns the exact-map value for an enumerated model', () => {
  assert.equal(resolveContextWindow('claude-opus-4.7'), 200_000);
  assert.equal(resolveContextWindow('gpt-5.3-codex'), 400_000);
  assert.equal(resolveContextWindow('gemini-3.1-pro-preview'), 1_000_000);
});

test('resolveContextWindow falls back to the family prefix for un-enumerated models', () => {
  // Regression: exact-match previously returned null for models in active use,
  // hiding the entire budget panel (e.g. the implementing model for this PR).
  assert.equal(resolveContextWindow('claude-opus-4.8'), 200_000);
  assert.equal(resolveContextWindow('gpt-5.4-codex'), 400_000);
  assert.equal(resolveContextWindow('gpt-5-mini'), 400_000);
  assert.equal(resolveContextWindow('gemini-9.9-ultra'), 1_000_000);
  assert.equal(resolveContextWindow('mai-code-2-flash'), 200_000);
});

test('resolveContextWindow returns null for unknown families and empty input', () => {
  assert.equal(resolveContextWindow('llama-3-70b'), null);
  assert.equal(resolveContextWindow(''), null);
  assert.equal(resolveContextWindow(null), null);
  assert.equal(resolveContextWindow(undefined), null);
});

// --- computeParallelStats -------------------------------------------------

test('computeParallelStats returns zeros for no tools', () => {
  assert.deepEqual(computeParallelStats([]), {
    parallelToolTimeMs: 0,
    serialToolTimeMs: 0,
    parallelismRatio: 0,
    maxParallelism: 0,
  });
});

test('computeParallelStats treats a single tool as fully serial', () => {
  const r = computeParallelStats([{ start: 0, end: 10 }]);
  assert.equal(r.serialToolTimeMs, 10);
  assert.equal(r.parallelToolTimeMs, 0);
  assert.equal(r.parallelismRatio, 0);
  assert.equal(r.maxParallelism, 1);
});

test('computeParallelStats splits overlapping intervals into parallel vs serial', () => {
  // [0,10] and [5,15]: serial 0-5 and 10-15 (10ms), parallel 5-10 (5ms).
  const r = computeParallelStats([
    { start: 0, end: 10 },
    { start: 5, end: 15 },
  ]);
  assert.equal(r.serialToolTimeMs, 10);
  assert.equal(r.parallelToolTimeMs, 5);
  assert.equal(r.maxParallelism, 2);
  assert.ok(Math.abs(r.parallelismRatio - 5 / 15) < 1e-9);
});

test('computeParallelStats tracks peak concurrency across three overlapping tools', () => {
  const r = computeParallelStats([
    { start: 0, end: 30 },
    { start: 5, end: 25 },
    { start: 10, end: 20 },
  ]);
  assert.equal(r.maxParallelism, 3);
});

test('computeParallelStats does not count adjacent, touching intervals as parallel', () => {
  // [0,10] then [10,20] share only the boundary at t=10 — they never overlap.
  const r = computeParallelStats([
    { start: 0, end: 10 },
    { start: 10, end: 20 },
  ]);
  assert.equal(r.maxParallelism, 1);
  assert.equal(r.parallelToolTimeMs, 0);
  assert.equal(r.serialToolTimeMs, 20);
  assert.equal(r.parallelismRatio, 0);
});

// --- buildSummary ---------------------------------------------------------

/** Minimal but complete `raw` shape that buildSummary consumes. */
function makeRaw(over = {}) {
  const base = {
    sessionId: 's1',
    repository: 'nalfeo/Crawler',
    branch: 'main',
    cwd: '/repo',
    producer: 'test',
    selectedModel: 'claude-opus-4.8',
    startedAt: 0,
    endedAt: 10_000,
    tools: [],
    hooks: [],
    turns: [],
    usages: [],
    compactions: [],
    subagents: [],
    skillInvocations: [],
    errors: [],
    contextEvents: [],
    modelChanges: [],
    userMessageCount: 0,
    assistantMessageCount: 0,
    idleCount: 0,
    resumeCount: 0,
    reasoningCount: 0,
    reasoningChars: 0,
    reasoningOpaqueBytes: 0,
    totalAssistantChars: 0,
    externalToolRequests: 0,
    externalToolCompletions: 0,
    infoNotifications: 0,
  };
  return { ...base, ...over };
}

test('buildSummary rolls up walltime, tool/api counts, tokens and failures', () => {
  const raw = makeRaw({
    tools: [
      { name: 'view', durationMs: 100, success: true, start: 0, end: 100, turnIndex: 0 },
      { name: 'edit', durationMs: 200, success: false, start: 100, end: 300, turnIndex: 0 },
    ],
    usages: [
      {
        model: 'claude-opus-4.8',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
        cost: 0.5,
        turnIndex: 0,
      },
      {
        model: 'claude-opus-4.8',
        inputTokens: 30,
        outputTokens: 40,
        cacheReadTokens: 7,
        cacheWriteTokens: 2,
        cost: 1.5,
        turnIndex: 0,
      },
    ],
    turns: [
      {
        turnIndex: 0,
        start: 0,
        end: 10_000,
        durationMs: 10_000,
        userPromptChars: 12,
        assistantChars: 100,
      },
    ],
    compactions: [{ preTokens: 150_000 }],
  });

  const s = buildSummary(raw);

  assert.equal(s.walltimeMs, 10_000);
  assert.equal(s.totals.toolCalls, 2);
  assert.equal(s.totals.apiCalls, 2);
  assert.equal(s.totals.tokens.output, 60);
  assert.equal(s.totals.tokens.input, 40);
  assert.equal(s.totals.tokens.cost, 2);
  assert.equal(s.totals.peakContextTokens, 150_000);

  const editAgg = s.toolAggregates.find((t) => t.name === 'edit');
  assert.equal(editAgg.failures, 1);
  const viewAgg = s.toolAggregates.find((t) => t.name === 'view');
  assert.equal(viewAgg.failures, 0);
});

test('buildSummary resolves the budget model via prefix fallback', () => {
  const s = buildSummary(makeRaw({ selectedModel: 'claude-opus-4.8' }));
  assert.equal(s.budgetModel, 'claude-opus-4.8');
  assert.equal(s.modelContextBudget, 200_000);
});

test('buildSummary prefers a concrete usage model when selectedModel is auto', () => {
  const s = buildSummary(
    makeRaw({
      selectedModel: 'auto',
      usages: [
        {
          model: 'gpt-5.4-codex',
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          turnIndex: 0,
        },
      ],
    }),
  );
  assert.equal(s.budgetModel, 'gpt-5.4-codex');
  assert.equal(s.modelContextBudget, 400_000);
});

test('buildSummary groups usages into a per-model breakdown', () => {
  const s = buildSummary(
    makeRaw({
      usages: [
        {
          model: 'claude-opus-4.8',
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 1,
          turnIndex: 0,
        },
        {
          model: 'gpt-5.4',
          inputTokens: 5,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 3,
          turnIndex: 0,
        },
      ],
    }),
  );
  assert.equal(s.modelBreakdown.length, 2);
  // Sorted by cost desc — gpt-5.4 (3) before claude (1).
  assert.equal(s.modelBreakdown[0].model, 'gpt-5.4');
  assert.equal(s.modelBreakdown[0].callCount, 1);
});

test('buildSummary attaches a wallclock waterfall with one lane per tool', () => {
  const s = buildSummary(
    makeRaw({
      tools: [
        { name: 'view', durationMs: 100, success: true, start: 0, end: 100, turnIndex: 0 },
        { name: 'edit', durationMs: 200, success: false, start: 100, end: 300, turnIndex: 0 },
      ],
      turns: [{ turnIndex: 0, start: 0, end: 10_000, durationMs: 10_000 }],
    }),
  );
  assert.ok(s.waterfall);
  assert.equal(s.waterfall.axis, 'wallclock');
  // One lane per tool call — never merged onto a single track.
  assert.equal(s.waterfall.rows.length, 2);
});

// --- buildWaterfall -------------------------------------------------------

test('buildWaterfall maps tools onto a shared wall-clock axis by real start/duration', () => {
  const wf = buildWaterfall({
    startedAt: 0,
    endedAt: 1000,
    tools: [
      {
        callId: 'a',
        name: 'view',
        start: 0,
        end: 100,
        durationMs: 100,
        success: true,
        turnIndex: 0,
      },
      {
        callId: 'b',
        name: 'edit',
        start: 500,
        end: 1000,
        durationMs: 500,
        success: true,
        turnIndex: 0,
      },
    ],
    turns: [],
  });
  assert.equal(wf.axis, 'wallclock');
  assert.equal(wf.spanMs, 1000);
  assert.equal(wf.rows.length, 2);
  // First lane: [0,100] → left 0%, width 10%.
  assert.equal(wf.rows[0].leftPct, 0);
  assert.equal(wf.rows[0].widthPct, 10);
  // Second lane: [500,1000] → left 50%, width 50%.
  assert.equal(wf.rows[1].leftPct, 50);
  assert.equal(wf.rows[1].widthPct, 50);
});

test('buildWaterfall orders lanes by real start time', () => {
  const wf = buildWaterfall({
    startedAt: 0,
    endedAt: 1000,
    tools: [
      { callId: 'late', name: 'b', start: 800, end: 900, durationMs: 100, turnIndex: 0 },
      { callId: 'early', name: 'a', start: 100, end: 200, durationMs: 100, turnIndex: 0 },
    ],
  });
  assert.deepEqual(
    wf.rows.map((r) => r.callId),
    ['early', 'late'],
  );
});

test('buildWaterfall keeps overlapping (parallel) calls as separate lanes', () => {
  const wf = buildWaterfall({
    startedAt: 0,
    endedAt: 1000,
    tools: [
      { callId: 'a', name: 'x', start: 0, end: 600, durationMs: 600, turnIndex: 0 },
      { callId: 'b', name: 'y', start: 300, end: 900, durationMs: 600, turnIndex: 0 },
    ],
  });
  assert.equal(wf.rows.length, 2);
  // Their x-ranges overlap (0–60% and 30–90%) — the classic parallel stack.
  assert.equal(wf.rows[0].leftPct, 0);
  assert.equal(wf.rows[0].widthPct, 60);
  assert.equal(wf.rows[1].leftPct, 30);
  assert.equal(wf.rows[1].widthPct, 60);
});

test('buildWaterfall extends the axis to cover an interval past endedAt', () => {
  const wf = buildWaterfall({
    startedAt: 0,
    endedAt: 1000,
    tools: [
      { callId: 'open', name: 'long', start: 0, end: 1500, durationMs: 1500, turnIndex: 0 },
      { callId: 'short', name: 's', start: 0, end: 1000, durationMs: 1000, turnIndex: 0 },
    ],
  });
  assert.equal(wf.spanMs, 1500);
  assert.equal(wf.endedAt, 1500);
  const long = wf.rows.find((r) => r.callId === 'open');
  assert.equal(long.widthPct, 100);
});

test('buildWaterfall generates evenly spaced axis ticks from 0 to span', () => {
  const wf = buildWaterfall({ startedAt: 1000, endedAt: 4000, tools: [] });
  assert.equal(wf.ticks.length, 7);
  assert.equal(wf.ticks[0].pct, 0);
  assert.equal(wf.ticks[0].ms, 0);
  assert.equal(wf.ticks[6].pct, 100);
  assert.equal(wf.ticks[6].ms, 3000);
});

test('buildWaterfall handles an empty session without throwing', () => {
  const wf = buildWaterfall({ startedAt: 0, endedAt: 0, tools: [] });
  assert.equal(wf.rows.length, 0);
  assert.equal(wf.totalRows, 0);
  assert.equal(wf.truncated, false);
  // An instant/empty session reports a real 0ms span (not a fabricated 1ms); the
  // >=1 clamp only lives in the internal layout denominator.
  assert.equal(wf.spanMs, 0);
  assert.ok(wf.context && wf.context.hasData === false);
});

test('buildWaterfall truncates to the earliest maxRows lanes and flags it', () => {
  const wf = buildWaterfall(
    {
      startedAt: 0,
      endedAt: 1000,
      tools: [
        { callId: 'c', name: 't', start: 300, end: 400, durationMs: 100, turnIndex: 0 },
        { callId: 'a', name: 't', start: 100, end: 200, durationMs: 100, turnIndex: 0 },
        { callId: 'b', name: 't', start: 200, end: 300, durationMs: 100, turnIndex: 0 },
      ],
    },
    { maxRows: 2 },
  );
  assert.equal(wf.totalRows, 3);
  assert.equal(wf.rows.length, 2);
  assert.equal(wf.truncated, true);
  // Kept the two earliest by start time.
  assert.deepEqual(
    wf.rows.map((r) => r.callId),
    ['a', 'b'],
  );
});

test('buildWaterfall normalizes success into true/false/null', () => {
  const wf = buildWaterfall({
    startedAt: 0,
    endedAt: 100,
    tools: [
      { callId: 'ok', name: 't', start: 0, end: 10, durationMs: 10, success: true, turnIndex: 0 },
      {
        callId: 'fail',
        name: 't',
        start: 10,
        end: 20,
        durationMs: 10,
        success: false,
        turnIndex: 0,
      },
      { callId: 'pending', name: 't', start: 20, end: 30, durationMs: 10, turnIndex: 0 },
    ],
  });
  const byId = Object.fromEntries(wf.rows.map((r) => [r.callId, r.success]));
  assert.equal(byId.ok, true);
  assert.equal(byId.fail, false);
  assert.equal(byId.pending, null);
});

test('buildWaterfall projects turn bands onto the same axis', () => {
  const wf = buildWaterfall({
    startedAt: 0,
    endedAt: 1000,
    tools: [],
    turns: [
      { turnIndex: 0, start: 0, end: 400, durationMs: 400, userPromptChars: 12, toolCount: 3 },
      { turnIndex: 1, start: 400, end: 1000, durationMs: 600, toolCount: 5 },
    ],
  });
  assert.equal(wf.turnBands.length, 2);
  assert.equal(wf.turnBands[0].leftPct, 0);
  assert.equal(wf.turnBands[0].widthPct, 40);
  assert.equal(wf.turnBands[0].toolCount, 3);
  assert.equal(wf.turnBands[1].leftPct, 40);
  assert.equal(wf.turnBands[1].widthPct, 60);
});

// --- buildWaterfall concern fixes (from plan review) ----------------------

test('buildWaterfall keeps a real 0ms tool as a 0-width lane (not missing)', () => {
  const wf = buildWaterfall({
    startedAt: 0,
    endedAt: 1000,
    tools: [{ callId: 'instant', name: 't', start: 500, end: 500, durationMs: 0, turnIndex: 0 }],
  });
  assert.equal(wf.rows.length, 1);
  assert.equal(wf.rows[0].durationMs, 0);
  assert.equal(wf.rows[0].widthPct, 0);
  assert.equal(wf.rows[0].leftPct, 50);
});

test('buildWaterfall sanitizes non-finite tool timestamps instead of producing NaN%', () => {
  const wf = buildWaterfall({
    startedAt: 0,
    endedAt: 1000,
    tools: [
      { callId: 'bad', name: 't', start: NaN, end: Infinity, durationMs: 5, turnIndex: 0 },
      { callId: 'ok', name: 't', start: 100, end: 200, durationMs: 100, turnIndex: 0 },
    ],
  });
  // The bad interval must not poison the axis or any pct.
  assert.ok(Number.isFinite(wf.spanMs));
  for (const r of wf.rows) {
    assert.ok(Number.isFinite(r.leftPct) && r.leftPct >= 0 && r.leftPct <= 100);
    assert.ok(Number.isFinite(r.widthPct) && r.widthPct >= 0 && r.widthPct <= 100);
  }
  const ok = wf.rows.find((r) => r.callId === 'ok');
  assert.equal(ok.leftPct, 10);
  assert.equal(ok.widthPct, 10);
});

// --- buildContextPoints ---------------------------------------------------

const AXIS = { t0: 0, t1: 1000, layoutSpanMs: 1000 };

test('buildContextPoints returns no data when there are no compactions', () => {
  const ctx = buildContextPoints(
    { compactions: [], contextEvents: [], budgetTokens: 200_000 },
    AXIS,
  );
  assert.equal(ctx.hasData, false);
  assert.equal(ctx.points.length, 0);
  assert.equal(ctx.budgetTokens, 200_000);
});

test('buildContextPoints maps a compaction onto the shared axis and budget', () => {
  const ctx = buildContextPoints(
    {
      compactions: [{ ts: 500, preTokens: 100_000, by: 'auto' }],
      contextEvents: [],
      budgetTokens: 200_000,
    },
    AXIS,
  );
  assert.equal(ctx.hasData, true);
  assert.equal(ctx.points.length, 1);
  const p = ctx.points[0];
  assert.equal(p.tokens, 100_000);
  assert.equal(p.xPct, 50); // ts 500 on a 1000ms axis
  assert.equal(ctx.maxTokens, 200_000); // max(peak, budget)
  assert.equal(p.tokensPct, 50); // 100k / 200k
  assert.equal(p.budgetPct, 50);
  assert.equal(p.overBudget, false);
  assert.equal(p.offAxis, false);
});

test('buildContextPoints scales to the peak and flags an over-budget sample', () => {
  const ctx = buildContextPoints(
    { compactions: [{ ts: 0, preTokens: 250_000 }], contextEvents: [], budgetTokens: 200_000 },
    AXIS,
  );
  const p = ctx.points[0];
  assert.equal(ctx.maxTokens, 250_000); // peak exceeds budget
  assert.equal(p.tokensPct, 100);
  assert.equal(p.overBudget, true);
  assert.ok(p.budgetPct > 100);
});

test('buildContextPoints works with no budget (peak-only scale)', () => {
  const ctx = buildContextPoints(
    { compactions: [{ ts: 100, preTokens: 40_000 }], contextEvents: [] },
    AXIS,
  );
  assert.equal(ctx.budgetTokens, null);
  assert.equal(ctx.maxTokens, 40_000);
  assert.equal(ctx.points[0].budgetPct, null);
  assert.equal(ctx.points[0].overBudget, false);
});

test('buildContextPoints clamps and flags an off-axis compaction', () => {
  const ctx = buildContextPoints(
    { compactions: [{ ts: 2000, preTokens: 10_000 }], contextEvents: [] },
    AXIS,
  );
  assert.equal(ctx.points[0].xPct, 100); // ts 2000 > t1 1000 → clamped
  assert.equal(ctx.points[0].offAxis, true);
  assert.equal(ctx.offAxisCount, 1);
});

test('buildContextPoints sorts points by timestamp and skips unusable samples', () => {
  const ctx = buildContextPoints(
    {
      compactions: [
        { ts: 800, preTokens: 30_000 },
        { ts: 200, preTokens: 20_000 },
        { ts: 400, preTokens: 0 }, // no usable size → skipped
        { ts: 600 }, // no preTokens → skipped
      ],
      contextEvents: [],
    },
    AXIS,
  );
  assert.deepEqual(
    ctx.points.map((p) => p.tokens),
    [20_000, 30_000],
  );
  assert.equal(ctx.peakTokens, 30_000);
});

test('buildContextPoints pairs breakdowns FIFO and omits them when ambiguous', () => {
  // Mixed contextEvents stream: only compaction_start carries a breakdown.
  const ctx = buildContextPoints(
    {
      compactions: [
        { ts: 200, preTokens: 8_000, by: 'auto' }, // pairs with start@100
        { ts: 400, preTokens: 6_000, by: 'unknown' }, // truncation, no preceding start → no breakdown
      ],
      contextEvents: [
        {
          ts: 100,
          type: 'compaction_start',
          systemTokens: 10,
          conversationTokens: 20,
          toolDefinitionsTokens: 5,
        },
        { ts: 210, type: 'compaction_end' },
        { ts: 350, type: 'warning', message: 'x' },
      ],
      budgetTokens: 200_000,
    },
    AXIS,
  );
  assert.equal(ctx.breakdownCount, 1);
  assert.deepEqual(ctx.points[0].breakdown, {
    systemTokens: 10,
    conversationTokens: 20,
    toolDefinitionsTokens: 5,
  });
  assert.equal(ctx.points[1].breakdown, null);
});

test('buildContextPoints does not pair a start that comes after the compaction', () => {
  const ctx = buildContextPoints(
    {
      compactions: [{ ts: 50, preTokens: 5_000 }],
      contextEvents: [
        {
          ts: 100,
          type: 'compaction_start',
          systemTokens: 1,
          conversationTokens: 2,
          toolDefinitionsTokens: 3,
        },
      ],
    },
    AXIS,
  );
  assert.equal(ctx.breakdownCount, 0);
  assert.equal(ctx.points[0].breakdown, null);
});

test('buildContextPoints uses the last of several starts preceding one compaction', () => {
  // Two compaction_start events both precede a single compaction (anomalous —
  // a start whose cycle never logged a compaction, then the real one). The FIFO
  // walk consumes both and keeps the LAST (most recent) as that compaction's
  // cycle start, so the breakdown reflects the freshest pre-compaction snapshot.
  const ctx = buildContextPoints(
    {
      compactions: [{ ts: 300, preTokens: 9_000, by: 'auto' }],
      contextEvents: [
        {
          ts: 100,
          type: 'compaction_start',
          systemTokens: 1,
          conversationTokens: 1,
          toolDefinitionsTokens: 1,
        },
        {
          ts: 250,
          type: 'compaction_start',
          systemTokens: 40,
          conversationTokens: 50,
          toolDefinitionsTokens: 6,
        },
      ],
      budgetTokens: 200_000,
    },
    AXIS,
  );
  assert.equal(ctx.breakdownCount, 1);
  assert.deepEqual(ctx.points[0].breakdown, {
    systemTokens: 40,
    conversationTokens: 50,
    toolDefinitionsTokens: 6,
  });
});

test('buildContextPoints does not let an interleaved truncation steal the auto-compaction breakdown', () => {
  // Regression (code review): a truncation whose ts falls between a
  // compaction_start and its owning auto-compaction must NOT consume that start.
  // Only by:'auto' compactions pair with a compaction_start; truncations stay null.
  const ctx = buildContextPoints(
    {
      compactions: [
        { ts: 150, preTokens: 5_000, by: 'unknown' }, // truncation between start@100 and auto@200
        { ts: 200, preTokens: 8_000, by: 'auto' }, // real owner of start@100
      ],
      contextEvents: [
        {
          ts: 100,
          type: 'compaction_start',
          systemTokens: 111,
          conversationTokens: 222,
          toolDefinitionsTokens: 33,
        },
      ],
      budgetTokens: 200_000,
    },
    AXIS,
  );
  assert.equal(ctx.breakdownCount, 1);
  const trunc = ctx.points.find((p) => p.by === 'unknown');
  const auto = ctx.points.find((p) => p.by === 'auto');
  assert.equal(trunc.breakdown, null); // truncation does not steal the start
  assert.deepEqual(auto.breakdown, {
    systemTokens: 111,
    conversationTokens: 222,
    toolDefinitionsTokens: 33,
  });
});

test('buildWaterfall aligns a context point with the lane running at that time', () => {
  const wf = buildWaterfall({
    startedAt: 0,
    endedAt: 1000,
    tools: [{ callId: 'x', name: 't', start: 500, end: 600, durationMs: 100, turnIndex: 0 }],
    compactions: [{ ts: 500, preTokens: 100_000 }],
    contextEvents: [],
    budgetTokens: 200_000,
  });
  assert.ok(wf.context.hasData);
  // The compaction dot sits exactly above the lane that started at the same ts.
  assert.equal(wf.context.points[0].xPct, wf.rows[0].leftPct);
});

test('buildSummary threads compaction/context/budget into s.waterfall.context', () => {
  const raw = makeRaw({
    endedAt: 10_000,
    compactions: [{ ts: 5_000, preTokens: 120_000, by: 'auto' }],
  });
  const s = buildSummary(raw);
  assert.ok(s.waterfall.context);
  assert.equal(s.waterfall.context.hasData, true);
  assert.equal(s.waterfall.context.points.length, 1);
  assert.equal(s.waterfall.context.points[0].tokens, 120_000);
  // Budget flows from the resolved model context window.
  assert.equal(s.waterfall.context.budgetTokens, s.modelContextBudget);
  assert.ok(s.waterfall.context.budgetTokens > 0);
});

// --- renderer structural guard --------------------------------------------

test('renderHtml ships the context-pressure chart wired into the waterfall', () => {
  const html = renderHtml('inst-1');
  assert.match(html, /function contextPressureChart/);
  // Context strip + ruler share one sticky header inside the scroll container.
  assert.match(html, /class="wf-head"/);
  assert.match(html, /contextPressureChart\(wf\)/);
  assert.match(html, /class="wf-ctx/);
  assert.match(html, /class="budget"/);
});

test('renderHtml escapes context tooltips and states the honest data limitation', () => {
  const html = renderHtml('inst-1');
  // Tooltips are escaped (no raw interpolation of names/notes).
  assert.match(html, /esc\(tip\)/);
  // The empty state must be honest: context size is only sampled at compactions.
  assert.match(html, /only sampled when a compaction fires/);
});

test('context tooltip rides the visible knob + stem, not the zero-width .pt wrapper (PR #842)', () => {
  const html = renderHtml('inst-1');
  // Regression guard: `.wf-ctx .track .pt` is `width:0`, so a `title` on the
  // wrapper has no hittable area and never shows on hover. The tooltip must be
  // attached to the visible <i class="stem"> and <i class="knob"> instead, and
  // stay escaped.
  assert.match(html, /const tipAttr = ' title="' \+ esc\(tip\)/);
  assert.match(html, /"stem"'\s*\+\s*tipAttr/);
  assert.match(html, /"knob"'\s*\+\s*tipAttr/);
});

test('waterfall still renders the context strip for sessions with compactions but no tool calls (PR #842)', () => {
  const html = renderHtml('inst-1');
  // Regression guard: a session with real context high-water marks but zero tool
  // calls must NOT collapse to the whole-panel "No tool calls recorded." bail.
  // viewWaterfall renders when there are tool lanes OR context.hasData.
  assert.ok(html.includes('const hasContext = !!(wf && wf.context && wf.context.hasData);'));
  assert.ok(html.includes('if (!wf || (!hasRows && !hasContext)) return'));
  // ...and it shows an honest empty-plot note in that case.
  assert.ok(html.includes('No tool calls in this session'));
});

test('waterfall bars floor rendered width at 1px so the true axis position is not distorted (PR #842)', () => {
  const html = renderHtml('inst-1');
  // Regression guard: only the rendered WIDTH is floored (anti-vanish for 0ms
  // spans); a 1px floor is below the visual-overlap threshold, so it cannot
  // manufacture a false "parallel" look. Bar POSITION always uses true leftPct.
  assert.ok(html.includes('.wf-plot .wf-row .track .seg { min-width: 1px; }'));
  assert.ok(!html.includes('min-width: 2px'));
});

test('buildSummary aggregates per-tool context cost and ranks the biggest sinks', () => {
  // A fast tool that returns a huge payload is the classic compaction cause,
  // so context ranking must not follow latency ranking.
  const raw = makeRaw({
    tools: [
      {
        name: 'grep',
        durationMs: 10,
        success: true,
        start: 0,
        end: 10,
        turnIndex: 0,
        resultSizeBytes: 300_000,
      },
      {
        name: 'grep',
        durationMs: 10,
        success: true,
        start: 10,
        end: 20,
        turnIndex: 0,
        resultSizeBytes: 100_000,
      },
      {
        name: 'build',
        durationMs: 60_000,
        success: true,
        start: 20,
        end: 60_020,
        turnIndex: 0,
        resultSizeBytes: 500,
      },
    ],
  });

  const s = buildSummary(raw);

  const grep = s.toolAggregates.find((t) => t.name === 'grep');
  assert.equal(grep.totalResultBytes, 400_000);
  assert.equal(grep.avgResultBytes, 200_000);
  assert.equal(grep.maxResultBytes, 300_000);

  // Latency order puts the slow build first; context order must not.
  assert.equal(s.toolAggregates[0].name, 'build');
  assert.equal(s.contextSinks[0].name, 'grep');
  assert.equal(s.contextSinks[1].name, 'build');
});

test('contextSinks omits tools that never returned a payload', () => {
  const raw = makeRaw({
    tools: [{ name: 'edit', durationMs: 5, success: true, start: 0, end: 5, turnIndex: 0 }],
  });
  const s = buildSummary(raw);
  assert.equal(s.toolAggregates.find((t) => t.name === 'edit').totalResultBytes, 0);
  assert.deepEqual(s.contextSinks, []);
});
