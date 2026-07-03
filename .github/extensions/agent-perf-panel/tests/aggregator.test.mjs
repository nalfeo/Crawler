import test from 'node:test';
import assert from 'node:assert/strict';

import { sumSessionTotals } from '../aggregator.mjs';

/** A per-session row with every numeric field the reducer touches. */
function row(over = {}) {
  const base = {
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
  };
  return { ...base, ...over };
}

test('sumSessionTotals returns an all-zero object for no sessions', () => {
  const t = sumSessionTotals([]);
  assert.equal(t.sessions, 0);
  assert.equal(t.walltimeMs, 0);
  assert.equal(t.outputTokens, 0);
  assert.equal(t.errors, 0);
});

test('sumSessionTotals counts sessions and sums every numeric field', () => {
  const t = sumSessionTotals([
    row({
      walltimeMs: 1000,
      toolCalls: 3,
      outputTokens: 50,
      apiCalls: 2,
      errors: 1,
      subagentSpawns: 1,
    }),
    row({
      walltimeMs: 2000,
      toolCalls: 4,
      outputTokens: 70,
      apiCalls: 5,
      errors: 0,
      subagentSpawns: 2,
    }),
  ]);
  assert.equal(t.sessions, 2);
  assert.equal(t.walltimeMs, 3000);
  assert.equal(t.toolCalls, 7);
  assert.equal(t.outputTokens, 120);
  assert.equal(t.apiCalls, 7);
  assert.equal(t.errors, 1);
  assert.equal(t.subagentSpawns, 3);
});

test('sumSessionTotals does not mutate its input rows', () => {
  const r = row({ walltimeMs: 5 });
  sumSessionTotals([r]);
  assert.equal(r.walltimeMs, 5);
});
