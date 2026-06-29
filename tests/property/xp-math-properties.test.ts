import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { xpThresholdForLevel, xpRequiredForLevel, levelForXp } from '../../src/shared/xpMath.js';

/**
 * Property-based invariants for the pure XP curve helpers. These complement the
 * round-trip / monotonicity checks already in stats-properties.test.ts by
 * pinning the *structural* relationships between the three functions
 * (threshold ↔ cumulative requirement ↔ inverse level lookup) and the clamping
 * behaviour at the boundaries.
 */
describe('xpMath invariants (property-based)', () => {
  it('xpThresholdForLevel is a non-negative integer', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), (level) => {
        const t = xpThresholdForLevel(level);
        expect(Number.isInteger(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('xpRequiredForLevel is non-negative and starts at 0', () => {
    expect(xpRequiredForLevel(0)).toBe(0);
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 500 }), (level) => {
        expect(xpRequiredForLevel(level)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('cumulative identity: required(n+1) − required(n) === threshold(n)', () => {
    // The identity is exact in integer arithmetic; bound the range so the
    // running total stays within Number.MAX_SAFE_INTEGER (the exponential curve
    // crosses 2^53 around level ~232, far above any realistic play level).
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (level) => {
        fc.pre(xpRequiredForLevel(level + 1) <= Number.MAX_SAFE_INTEGER);
        expect(xpRequiredForLevel(level + 1) - xpRequiredForLevel(level)).toBe(
          xpThresholdForLevel(level),
        );
      }),
    );
  });

  it('required(n) equals the running sum of thresholds 0..n−1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 120 }), (level) => {
        let sum = 0;
        for (let k = 0; k < level; k += 1) sum += xpThresholdForLevel(k);
        expect(xpRequiredForLevel(level)).toBe(sum);
      }),
    );
  });

  it('levelForXp is monotonic non-decreasing in xp', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(levelForXp(hi)).toBeGreaterThanOrEqual(levelForXp(lo));
        },
      ),
    );
  });

  it('levelForXp inverts xpRequiredForLevel at the level boundary', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (level) => {
        // At exactly the requirement we are at `level`.
        expect(levelForXp(xpRequiredForLevel(level))).toBe(level);
        // One XP short of the *next* level we are still at `level`, provided the
        // next threshold actually costs something (it always does on this curve).
        const nextThreshold = xpThresholdForLevel(level);
        fc.pre(nextThreshold >= 1);
        expect(levelForXp(xpRequiredForLevel(level + 1) - 1)).toBe(level);
      }),
    );
  });

  it('levelForXp clamps to 0 for non-positive xp and never exceeds the 1000 cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 0 }), (xp) => {
        expect(levelForXp(xp)).toBe(0);
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (xp) => {
        const lvl = levelForXp(xp);
        expect(lvl).toBeGreaterThanOrEqual(0);
        expect(lvl).toBeLessThanOrEqual(1000);
      }),
    );
    expect(levelForXp(Number.POSITIVE_INFINITY)).toBe(1000);
  });
});
