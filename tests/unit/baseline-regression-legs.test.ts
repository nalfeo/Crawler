import { describe, expect, it } from 'vitest';
import {
  MIN_ADDITIONAL_LOSSES,
  evaluateLegRegressions,
  type BaselineLegMetrics,
} from '../../scripts/agent/perf/baseline-regression-check.js';

function leg(totalWins: number, totalRuns: number): BaselineLegMetrics {
  return { totalWins, totalRuns, winRate: totalWins / totalRuns };
}

describe('per-leg baseline regression evaluation', () => {
  it('returns undefined when either baseline has no leg metrics', () => {
    // A pre-multi-floor baseline has no legs; comparing against it must degrade
    // to the aggregate-only path rather than inventing leg verdicts.
    expect(evaluateLegRegressions(undefined, { floor1: leg(90, 100) })).toBeUndefined();
    expect(evaluateLegRegressions({ floor1: leg(90, 100) }, undefined)).toBeUndefined();
  });

  it('flags a leg that drops beyond tolerance', () => {
    const result = evaluateLegRegressions({ floor2: leg(90, 100) }, { floor2: leg(80, 100) })!;
    expect(result).toHaveLength(1);
    expect(result[0]!.legId).toBe('floor2');
    expect(result[0]!.regression).toBe(true);
    expect(result[0]!.additionalLosses).toBe(10);
    expect(result[0]!.winRateDrop).toBeCloseTo(0.1, 10);
  });

  it('does not flag a single-run loss (noise suppression)', () => {
    // Same both-conditions rule as the aggregate: one extra loss is below
    // MIN_ADDITIONAL_LOSSES and must never file.
    const result = evaluateLegRegressions({ floor1: leg(100, 100) }, { floor1: leg(99, 100) })!;
    expect(MIN_ADDITIONAL_LOSSES).toBeGreaterThan(1);
    expect(result[0]!.regression).toBe(false);
  });

  it('does not flag an improvement', () => {
    const result = evaluateLegRegressions({ floor1: leg(80, 100) }, { floor1: leg(95, 100) })!;
    expect(result[0]!.regression).toBe(false);
  });

  it('skips a leg whose run count changed instead of firing a false regression', () => {
    // Resizing the sweep matrix is a methodology change, not a gameplay
    // regression; comparing across sizes would fire on the first release after
    // the change.
    const result = evaluateLegRegressions({ floor2: leg(90, 100) }, { floor2: leg(60, 150) })!;
    expect(result[0]!.regression).toBe(false);
    expect(result[0]!.reason).toMatch(/run count changed/);
  });

  it('skips a leg that exists in only one baseline', () => {
    const result = evaluateLegRegressions(
      { floor1: leg(90, 100) },
      { floor1: leg(90, 100), 'floor1-chain': leg(10, 100) },
    )!;
    expect(result.map((r) => r.legId)).toEqual(['floor1']);
  });

  it('rejects a leg whose winRate disagrees with wins/runs', () => {
    expect(() =>
      evaluateLegRegressions(
        { floor1: leg(90, 100) },
        { floor1: { totalWins: 90, totalRuns: 100, winRate: 0.5 } },
      ),
    ).toThrow(/does not match totalWins\/totalRuns/);
  });

  it('evaluates legs in a stable sorted order', () => {
    const legs = {
      floor2: leg(50, 100),
      floor1: leg(90, 100),
      'floor1-chain': leg(20, 100),
    };
    expect(evaluateLegRegressions(legs, legs)!.map((r) => r.legId)).toEqual([
      'floor1',
      'floor1-chain',
      'floor2',
    ]);
  });
});
