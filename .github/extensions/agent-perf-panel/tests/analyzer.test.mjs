import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveContextWindow, computeParallelStats, buildSummary } from '../analyzer.mjs';

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
