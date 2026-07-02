import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeEffectiveValue, computeEffectiveSpeed } from '../../src/core/status-effects.js';
import type { StatusEffect, StatusEffectOp } from '../../src/shared/status-effect-types.js';

/**
 * Property-based invariants for the product-of-factors effective-value math:
 * clamp bounds always hold, multiplicative slows never flip sign, composition is
 * order-independent, and the closed form matches. Values are bounded so the
 * Float-backed arithmetic stays well within safe magnitudes.
 */

function toEffect(op: StatusEffectOp, value: number): StatusEffect {
  return {
    stat: 'speed',
    op,
    value,
    durationMs: null,
    sourceType: 'debug',
    sourceId: 'p',
    stackRule: { mode: 'replace' },
    remainingMs: Infinity,
  };
}

const anyEffect = (): fc.Arbitrary<StatusEffect> =>
  fc.oneof(
    fc.double({ min: -500, max: 500, noNaN: true }).map((v) => toEffect('add', v)),
    fc.double({ min: 0, max: 3, noNaN: true }).map((v) => toEffect('multiply', v)),
  );

const mulEffect = (): fc.Arbitrary<StatusEffect> =>
  fc.double({ min: 0, max: 3, noNaN: true }).map((v) => toEffect('multiply', v));

const clamps = (): fc.Arbitrary<{ min: number; max: number }> =>
  fc
    .tuple(
      fc.double({ min: -1000, max: 1000, noNaN: true }),
      fc.double({ min: -1000, max: 1000, noNaN: true }),
    )
    .map(([a, b]) => ({ min: Math.min(a, b), max: Math.max(a, b) }));

describe('computeEffectiveValue invariants', () => {
  it('result is always within the given clamp bounds', () => {
    fc.assert(
      fc.property(
        fc.array(anyEffect(), { maxLength: 6 }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        clamps(),
        (effects, base, cl) => {
          const v = computeEffectiveValue(base, effects, 'speed', cl);
          expect(v).toBeGreaterThanOrEqual(cl.min);
          expect(v).toBeLessThanOrEqual(cl.max);
        },
      ),
    );
  });

  it('multiply-only effects on a non-negative base never go negative', () => {
    fc.assert(
      fc.property(
        fc.array(mulEffect(), { maxLength: 6 }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (effects, base) => {
          expect(computeEffectiveValue(base, effects, 'speed')).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('composition is order-independent (commutative product + sum)', () => {
    fc.assert(
      fc.property(
        fc.array(anyEffect(), { minLength: 1, maxLength: 6 }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (effects, base) => {
          const forward = computeEffectiveValue(base, effects, 'speed');
          const reversed = computeEffectiveValue(base, [...effects].reverse(), 'speed');
          expect(reversed).toBeCloseTo(forward, 6);
        },
      ),
    );
  });

  it('matches the closed form (base + Σadd) * Π multiply', () => {
    fc.assert(
      fc.property(
        fc.array(anyEffect(), { maxLength: 6 }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        (effects, base) => {
          let add = 0;
          let mul = 1;
          for (const e of effects) {
            if (e.op === 'add') add += e.value;
            else mul *= e.value;
          }
          expect(computeEffectiveValue(base, effects, 'speed')).toBe((base + add) * mul);
        },
      ),
    );
  });
});

describe('computeEffectiveSpeed default clamp', () => {
  it('stays within [0, base * 3] for a non-negative base', () => {
    fc.assert(
      fc.property(
        fc.array(anyEffect(), { maxLength: 6 }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (effects, base) => {
          const v = computeEffectiveSpeed(base, effects);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(base * 3);
        },
      ),
    );
  });
});
