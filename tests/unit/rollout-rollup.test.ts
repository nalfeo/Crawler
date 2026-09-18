import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_LINES_PER_FILE,
  parseRolloutFile,
  rollup,
} from '../../scripts/agent/velocity/rollout-rollup';

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
    const stats = parseRolloutFile(
      '{"type":"token_usage_record","payload":{"usage":{"input_tokens":5}}}',
      'empty.jsonl',
    );
    expect(stats.responseCount).toBe(1);
    expect(stats.cachedInputTokens).toBeNull();
    expect(stats.outputTokens).toBeNull();
    expect(stats.reasoningTokens).toBeNull();
    expect(stats.cacheHitPercentage).toBeNull();
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

  it('reports an unterminated record beyond the line cap as truncated', () => {
    const text = `${'\n'.repeat(MAX_LINES_PER_FILE)}{"type":"future.event"}`;
    expect(parseRolloutFile(text, 'oversized.jsonl').truncated).toBe(true);
  });

  it('keeps aggregate optional metrics unavailable when any file omits them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'crawler-rollup-'));
    const complete = join(directory, 'complete.jsonl');
    const incomplete = join(directory, 'incomplete.jsonl');
    try {
      writeFileSync(
        complete,
        '{"type":"token_usage_record","payload":{"usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":2,"reasoning_output_tokens":1}}}',
      );
      writeFileSync(
        incomplete,
        '{"type":"token_usage_record","payload":{"usage":{"input_tokens":10}}}',
      );
      const aggregate = rollup([complete, incomplete]).aggregate;
      expect(aggregate.cachedInputTokens).toBeNull();
      expect(aggregate.uncachedInputTokens).toBeNull();
      expect(aggregate.outputTokens).toBeNull();
      expect(aggregate.reasoningTokens).toBeNull();
      expect(aggregate.cacheHitPercentage).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
