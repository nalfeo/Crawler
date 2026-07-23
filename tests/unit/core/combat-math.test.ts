import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeArmorReducedDamage,
  computeEffectiveAccuracyFromValues,
  computeExpectedCritDamage,
  computePlayerScaledDamage,
} from '../../../src/core/combat-math.js';
import { WeaponType } from '../../../src/shared/constants.js';

describe('combat math', () => {
  it('applies additive, percentage, and typed-primary player damage scaling', () => {
    expect(
      computePlayerScaledDamage(
        10,
        { damageBonus: 2, damagePercent: 0.5, strength: 10 },
        { affinity: 'physical', scaleWithPrimary: false },
      ),
    ).toBe(18);
    expect(
      computePlayerScaledDamage(
        10,
        { damageBonus: 2, damagePercent: 0.5, strength: 10 },
        { affinity: 'physical', scaleWithPrimary: true },
      ),
    ).toBeGreaterThan(18);
  });

  it.each([
    { chance: -1, multiplier: 2, expected: 10 },
    { chance: 0, multiplier: 2, expected: 10 },
    { chance: 0.5, multiplier: 2, expected: 15 },
    { chance: 1, multiplier: 2, expected: 20 },
    { chance: 2, multiplier: 2, expected: 20 },
    { chance: 1, multiplier: 0, expected: 10 },
    { chance: 1, multiplier: 1, expected: 10 },
  ])(
    'computes clamped expected crit damage for chance $chance and multiplier $multiplier',
    ({ chance, multiplier, expected }) => {
      expect(computeExpectedCritDamage(10, chance, multiplier)).toBe(expected);
    },
  );

  it('never lowers non-negative damage for valid crit multipliers', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: 1, max: 10, noNaN: true }),
        (amount, chance, multiplier) => {
          expect(computeExpectedCritDamage(amount, chance, multiplier)).toBeGreaterThanOrEqual(
            amount,
          );
        },
      ),
    );
  });

  it('preserves the runtime minimum-damage armor contract', () => {
    expect(computeArmorReducedDamage(10, 3)).toBe(7);
    expect(computeArmorReducedDamage(10, 20)).toBe(1);
  });

  it('clamps weapon accuracy while traps remain guaranteed hits', () => {
    expect(computeEffectiveAccuracyFromValues(WeaponType.RANGED, 0.7, 0.2)).toBeCloseTo(0.9);
    expect(computeEffectiveAccuracyFromValues(WeaponType.RANGED, 0.7, 1)).toBe(1);
    expect(computeEffectiveAccuracyFromValues(WeaponType.RANGED, 0.2, -1)).toBe(0);
    expect(computeEffectiveAccuracyFromValues(WeaponType.TRAP, 0, -100)).toBe(1);
  });
});
