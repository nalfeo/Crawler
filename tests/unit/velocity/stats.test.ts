import { describe, expect, it } from 'vitest';
import {
  MIN_SAMPLES_FOR_VERDICT,
  assertOneFactor,
  bootstrapMedianDeltaCi95,
  cliffsDelta,
  compareArms,
  effectSizeLabel,
  median,
  summarize,
} from '../../../scripts/agent/velocity/stats';
import { EXPERIMENT_SCHEMA, type ExperimentSpec } from '../../../scripts/agent/velocity/types';

function spec(overrides: Partial<ExperimentSpec>): ExperimentSpec {
  return {
    schema: EXPERIMENT_SCHEMA,
    id: 'test-experiment',
    hypothesis: 'h',
    factor: 'environment',
    pack: 'pack.json',
    arms: [],
    trials: 3,
    ...overrides,
  };
}

describe('median / summarize', () => {
  it('handles odd and even sample counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('reports NaN rather than 0 for an empty sample', () => {
    // 0 would silently read as "this arm was free", which is a dangerous lie.
    expect(summarize([]).n).toBe(0);
    expect(Number.isNaN(summarize([]).median)).toBe(true);
  });

  it('summarises a populated sample', () => {
    expect(summarize([10, 20, 30])).toEqual({ n: 3, median: 20, mean: 20, min: 10, max: 30 });
  });
});

describe("Cliff's delta", () => {
  it('is +1 when every treatment value exceeds every baseline value', () => {
    expect(cliffsDelta([1, 2, 3], [4, 5, 6])).toBe(1);
  });

  it('is -1 when every treatment value is below every baseline value', () => {
    expect(cliffsDelta([4, 5, 6], [1, 2, 3])).toBe(-1);
  });

  it('is 0 for identical distributions', () => {
    expect(cliffsDelta([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('labels magnitudes on the standard thresholds', () => {
    expect(effectSizeLabel(0.1)).toBe('negligible');
    expect(effectSizeLabel(0.2)).toBe('small');
    expect(effectSizeLabel(0.4)).toBe('medium');
    expect(effectSizeLabel(-0.9)).toBe('large');
  });
});

describe('bootstrap interval', () => {
  it('is deterministic for a given seed key', () => {
    const a = bootstrapMedianDeltaCi95([1, 2, 3, 4], [5, 6, 7, 8], 'key', 200);
    const b = bootstrapMedianDeltaCi95([1, 2, 3, 4], [5, 6, 7, 8], 'key', 200);
    expect(a).toEqual(b);
  });

  it('excludes zero for a clearly separated pair of samples', () => {
    const [low, high] = bootstrapMedianDeltaCi95([1, 1, 1, 1, 1], [9, 9, 9, 9, 9], 'sep', 500);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(0);
  });

  it('straddles zero for overlapping samples', () => {
    const [low, high] = bootstrapMedianDeltaCi95([1, 5, 9, 3, 7], [2, 6, 4, 8, 5], 'overlap', 500);
    expect(low).toBeLessThanOrEqual(0);
    expect(high).toBeGreaterThanOrEqual(0);
  });
});

describe('compareArms', () => {
  it('refuses to call a result conclusive below the minimum sample size', () => {
    const tiny = Array.from({ length: MIN_SAMPLES_FOR_VERDICT - 1 }, () => 1);
    const other = Array.from({ length: MIN_SAMPLES_FOR_VERDICT - 1 }, () => 99);
    expect(compareArms('modelCalls', 'a', tiny, 'b', other).conclusive).toBe(false);
  });

  it('marks a well-separated, adequately sampled comparison conclusive', () => {
    const result = compareArms(
      'modelCalls',
      'control',
      [20, 21, 22, 20, 21],
      'treatment',
      [10, 11, 10, 12, 11],
    );
    expect(result.conclusive).toBe(true);
    expect(result.medianDelta).toBeLessThan(0);
  });
});

describe('one-factor rule', () => {
  it('accepts an environment experiment where only setup differs', () => {
    expect(() =>
      assertOneFactor(
        spec({
          factor: 'environment',
          arms: [
            { id: 'control', description: 'baseline', model: 'gpt-5.4' },
            { id: 'treatment', description: 'extra skill', model: 'gpt-5.4', setup: ['echo hi'] },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects an experiment that changes environment AND model together', () => {
    expect(() =>
      assertOneFactor(
        spec({
          factor: 'environment',
          arms: [
            { id: 'control', description: 'baseline', model: 'gpt-5.4' },
            { id: 'treatment', description: 'both', model: 'claude-opus-5', setup: ['echo hi'] },
          ],
        }),
      ),
    ).toThrow(/two-factor/i);
  });

  it('rejects an experiment where the declared factor never varies', () => {
    expect(() =>
      assertOneFactor(
        spec({
          factor: 'model',
          arms: [
            { id: 'a', description: 'x', model: 'gpt-5.4' },
            { id: 'b', description: 'y', model: 'gpt-5.4' },
          ],
        }),
      ),
    ).toThrow(/no arm varies/i);
  });

  it('accepts a model experiment where only agent differs', () => {
    expect(() =>
      assertOneFactor(
        spec({
          factor: 'model',
          arms: [
            { id: 'a', description: 'producer', agent: 'producer' },
            { id: 'b', description: 'perf', agent: 'perf-optimizer' },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects an environment experiment that swaps agents', () => {
    expect(() =>
      assertOneFactor(
        spec({
          factor: 'environment',
          arms: [
            { id: 'a', description: 'producer', setup: ['echo baseline'], agent: 'producer' },
            {
              id: 'b',
              description: 'perf',
              setup: ['echo baseline'],
              agent: 'perf-optimizer',
            },
          ],
        }),
      ),
    ).toThrow(/two-factor/i);
  });

  it('rejects duplicate arm ids and single-arm experiments', () => {
    expect(() => assertOneFactor(spec({ arms: [{ id: 'only', description: 'x' }] }))).toThrow(
      /at least 2 arms/i,
    );
    expect(() =>
      assertOneFactor(
        spec({
          arms: [
            { id: 'dup', description: 'x' },
            { id: 'dup', description: 'y', setup: ['echo'] },
          ],
        }),
      ),
    ).toThrow(/duplicate arm id/i);
  });
});
