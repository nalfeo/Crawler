import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { resolveCrit, resolveDodge } from '../../src/core/combat-rolls.js';

/**
 * Property-based invariants for the pure crit/dodge resolution helpers. The
 * callers feed these a roll from `world.rng.next()` (a float in [0, 1)), so the
 * arbitraries mirror that contract while also probing the chance/amount/
 * multiplier ranges.
 */

const roll = () => fc.double({ min: 0, max: 0.999_999_999, noNaN: true });
const chance = () => fc.double({ min: 0, max: 1, noNaN: true });
const amount = () => fc.double({ min: 0, max: 1_000_000, noNaN: true });

describe('resolveCrit invariants (property-based)', () => {
  it('isCrit is exactly (critChance > 0 && roll < critChance)', () => {
    fc.assert(
      fc.property(
        roll(),
        amount(),
        chance(),
        fc.double({ min: 0, max: 10, noNaN: true }),
        (r, a, c, m) => {
          const result = resolveCrit(r, a, c, m);
          expect(result.isCrit).toBe(c > 0 && r < c);
        },
      ),
    );
  });

  it('a non-crit leaves the amount untouched', () => {
    fc.assert(
      fc.property(
        roll(),
        amount(),
        chance(),
        fc.double({ min: 0, max: 10, noNaN: true }),
        (r, a, c, m) => {
          const result = resolveCrit(r, a, c, m);
          if (!result.isCrit) {
            expect(result.amount).toBe(a);
          }
        },
      ),
    );
  });

  it('a crit with multiplier >= 1 never lowers the amount', () => {
    fc.assert(
      fc.property(roll(), amount(), fc.double({ min: 1, max: 10, noNaN: true }), (r, a, m) => {
        // Force the crit branch with critChance = 1 (roll is always < 1).
        const result = resolveCrit(r, a, 1, m);
        expect(result.isCrit).toBe(true);
        expect(result.amount).toBeGreaterThanOrEqual(a);
        expect(result.amount).toBe(a * m);
      }),
    );
  });

  it('a crit with a non-positive multiplier is treated as 1x (no damage lost)', () => {
    fc.assert(
      fc.property(roll(), amount(), fc.double({ min: -10, max: 0, noNaN: true }), (r, a, m) => {
        const result = resolveCrit(r, a, 1, m);
        expect(result.isCrit).toBe(true);
        expect(result.amount).toBe(a);
      }),
    );
  });

  it('is pure: identical inputs yield identical results', () => {
    fc.assert(
      fc.property(
        roll(),
        amount(),
        chance(),
        fc.double({ min: 0, max: 10, noNaN: true }),
        (r, a, c, m) => {
          expect(resolveCrit(r, a, c, m)).toEqual(resolveCrit(r, a, c, m));
        },
      ),
    );
  });

  it('never crits when critChance is zero', () => {
    fc.assert(
      fc.property(roll(), amount(), fc.double({ min: 0, max: 10, noNaN: true }), (r, a, m) => {
        const result = resolveCrit(r, a, 0, m);
        expect(result.isCrit).toBe(false);
        expect(result.amount).toBe(a);
      }),
    );
  });
});

describe('resolveDodge invariants (property-based)', () => {
  it('dodges exactly when (dodgeChance > 0 && roll < dodgeChance)', () => {
    fc.assert(
      fc.property(roll(), chance(), (r, c) => {
        expect(resolveDodge(r, c)).toBe(c > 0 && r < c);
      }),
    );
  });

  it('never dodges at zero chance and always dodges at chance 1 (roll < 1)', () => {
    fc.assert(
      fc.property(roll(), (r) => {
        expect(resolveDodge(r, 0)).toBe(false);
        expect(resolveDodge(r, 1)).toBe(true);
      }),
    );
  });
});
