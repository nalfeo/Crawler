import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseRolloutFile, rollup } from '../../scripts/agent/velocity/rollout-rollup';

const fixture = readFileSync(join(process.cwd(), 'tests/fixtures/rollout-rollup.jsonl'), 'utf8');

describe('rollout telemetry rollup', () => {
  it('aggregates supported usage, cache math, compaction, tools, and diagnostics', () => {
    const stats = parseRolloutFile(fixture, 'fixture.jsonl');
    expect(stats).toMatchObject({
      responseCount: 2,
      cumulativeInputTokens: 300,
      cachedInputTokens: 40,
      uncachedInputTokens: 260,
      outputTokens: 50,
      reasoningTokens: 12,
      cacheHitPercentage: 40 / 3,
      compactionCount: 1,
      toolCallCount: 1,
      medianInputTokens: 150,
      maxInputTokens: 200,
      malformedLineCount: 1,
      unknownEventCount: 1,
    });
  });

  it('does not invent zeroes for absent optional telemetry', () => {
    const stats = parseRolloutFile('{"type":"future.event","data":{}}', 'empty.jsonl');
    expect(stats.responseCount).toBeNull();
    expect(stats.compactionCount).toBeNull();
    expect(stats.toolCallCount).toBeNull();
    expect(() => rollup([])).toThrow(/at least one/);
  });

  it('sorts files and rolls up totals deterministically', () => {
    const first = join(process.cwd(), 'tests/fixtures/rollout-rollup.jsonl');
    const report = rollup([first, first]);
    expect(report.files.map((file) => file.path)).toEqual([first, first]);
    expect(report.aggregate.cumulativeInputTokens).toBe(600);
    expect(report.aggregate.cachedInputTokens).toBe(80);
    expect(report.aggregate.cacheHitPercentage).toBeCloseTo(80 / 6);
  });

  it('caps the model/tool-loop input surface', () => {
    expect(() =>
      rollup(Array.from({ length: 11 }, (_, index) => `missing-${index}.jsonl`)),
    ).toThrow(/At most 10/);
  });
});
