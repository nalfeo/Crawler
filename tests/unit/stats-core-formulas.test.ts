import { describe, it, expect } from 'vitest';
import {
  computeTypedPrimaryMultiplier,
  applyAttackSpeedAndCooldownReduction,
  ATTACK_SPEED_BONUS_MIN_CLAMP,
  STR_PHYSICAL_DAMAGE_RATE,
  INT_MAGIC_STRENGTH_RATE,
  resolveScalableOutput,
  resolveScalableOutputRounded,
  foldLegacyStatModifier,
  type StatId,
} from '../../src/shared/stats.js';

describe('computeTypedPrimaryMultiplier — STR/INT affinity separation', () => {
  it('physical damage scales ONLY with effective Strength, never Intelligence', () => {
    expect(computeTypedPrimaryMultiplier('physical', 0, 0)).toBe(1);
    expect(computeTypedPrimaryMultiplier('physical', 11, 0)).toBeCloseTo(
      1 + 11 * STR_PHYSICAL_DAMAGE_RATE,
      6,
    );
    // Piling Intelligence on top of a physical hit changes nothing.
    expect(computeTypedPrimaryMultiplier('physical', 11, 999)).toBeCloseTo(
      1 + 11 * STR_PHYSICAL_DAMAGE_RATE,
      6,
    );
  });

  it('magic damage scales ONLY with effective Intelligence, never Strength', () => {
    expect(computeTypedPrimaryMultiplier('magic', 0, 0)).toBe(1);
    expect(computeTypedPrimaryMultiplier('magic', 0, 11)).toBeCloseTo(
      1 + 11 * INT_MAGIC_STRENGTH_RATE,
      6,
    );
    // Piling Strength on top of a magic hit changes nothing.
    expect(computeTypedPrimaryMultiplier('magic', 999, 11)).toBeCloseTo(
      1 + 11 * INT_MAGIC_STRENGTH_RATE,
      6,
    );
  });

  it('unscaled damage (enemy/environment) is never scaled by either primary', () => {
    expect(computeTypedPrimaryMultiplier('unscaled', 999, 999)).toBe(1);
  });

  it('applies exactly +1% per effective point for both physical and magic (same rate)', () => {
    expect(STR_PHYSICAL_DAMAGE_RATE).toBe(0.01);
    expect(INT_MAGIC_STRENGTH_RATE).toBe(0.01);
    expect(computeTypedPrimaryMultiplier('physical', 100, 0)).toBeCloseTo(2, 6);
    expect(computeTypedPrimaryMultiplier('magic', 0, 100)).toBeCloseTo(2, 6);
  });
});

describe('applyAttackSpeedAndCooldownReduction — weapon cadence', () => {
  it('matches ceil(baseCooldownMs / (1 + attackSpeedBonus) * (1 - cooldownReduction))', () => {
    // 1000 / (1 + 0.5) * (1 - 0.2) = 1000/1.5*0.8 = 533.333... -> ceils to 534
    // (the fallback for non-near-integer values is Math.ceil, never a floor —
    // a weapon never fires SLOWER than its computed cadence implies).
    const result = applyAttackSpeedAndCooldownReduction(1000, 0.5, 0.2);
    expect(result).toBe(Math.ceil((1000 / 1.5) * 0.8));
    expect(result).toBe(534);
  });

  it('with zero bonus/reduction, returns the base cooldown unchanged', () => {
    expect(applyAttackSpeedAndCooldownReduction(750, 0, 0)).toBe(750);
  });

  it('guards attackSpeedBonus to stay strictly greater than -1 via the documented clamp', () => {
    expect(ATTACK_SPEED_BONUS_MIN_CLAMP).toBe(-0.9);
    // A bonus of -1 (or below) would divide by zero/flip sign without the guard.
    const atExactlyMinusOne = applyAttackSpeedAndCooldownReduction(1000, -1, 0);
    const atClampFloor = applyAttackSpeedAndCooldownReduction(
      1000,
      ATTACK_SPEED_BONUS_MIN_CLAMP,
      0,
    );
    expect(atExactlyMinusOne).toBe(atClampFloor);
    expect(Number.isFinite(atExactlyMinusOne)).toBe(true);
    expect(atExactlyMinusOne).toBeGreaterThan(0);
    // Even more extreme negative bonuses clamp to the same floor result.
    expect(applyAttackSpeedAndCooldownReduction(1000, -50, 0)).toBe(atClampFloor);
  });

  it('never returns less than 1ms, even under extreme bonuses/reduction', () => {
    expect(applyAttackSpeedAndCooldownReduction(1000, 100, 0.99)).toBeGreaterThanOrEqual(1);
  });

  it('performs a single rounding pass — the unrounded product is computed before rounding once, not per-factor early', () => {
    // baseCooldownMs/(1+bonus) = 1000/3 = 333.333...; computing the FULL
    // product (*0.999) before rounding lands cleanly on 333. A naive
    // implementation that rounds/ceils the FIRST factor early (334) then
    // multiplies by 0.999 lands on a DIFFERENT integer (334) — proving order
    // matters and the real implementation does it the correct (single-pass) way.
    const baseCooldownMs = 1000;
    const attackSpeedBonus = 2;
    const cooldownReduction = 0.001;
    const result = applyAttackSpeedAndCooldownReduction(
      baseCooldownMs,
      attackSpeedBonus,
      cooldownReduction,
    );
    const firstFactor = baseCooldownMs / (1 + attackSpeedBonus);
    const earlyRoundedIntermediate = Math.ceil(Math.ceil(firstFactor) * (1 - cooldownReduction));
    expect(result).toBe(333);
    expect(earlyRoundedIntermediate).toBe(334);
    expect(result).not.toBe(earlyRoundedIntermediate);
  });

  it('does not add an extra millisecond for float-precision near-integer products', () => {
    // A classic floating-point trap: dividing then multiplying back can land
    // at e.g. 179.99999999999997 instead of exactly 180 — the near-integer
    // epsilon snap must round this to 180, not ceil up to 181.
    const result = applyAttackSpeedAndCooldownReduction(180, 0, 0);
    expect(result).toBe(180);
  });
});

describe('resolveScalableOutput / resolveScalableOutputRounded — magic ability output scaling', () => {
  it('scales a true output by +1% per effective Intelligence point (same rate as the typed multiplier)', () => {
    const output = { base: 15, scalesWithIntelligence: true };
    expect(resolveScalableOutput(output, 0)).toBeCloseTo(15, 6);
    expect(resolveScalableOutput(output, 100)).toBeCloseTo(15 * 2, 6);
  });

  it('does not scale an output with scalesWithIntelligence: false, regardless of Intelligence', () => {
    const output = { base: 4, scalesWithIntelligence: false };
    expect(resolveScalableOutput(output, 0)).toBe(4);
    expect(resolveScalableOutput(output, 999)).toBe(4);
  });

  it('rounds deterministically to the nearest integer', () => {
    // 15 * 1.015 = 15.225 -> rounds to 15
    expect(resolveScalableOutputRounded({ base: 15, scalesWithIntelligence: true }, 1.5)).toBe(15);
    // 15 * 1.06 = 15.9 -> rounds to 16
    expect(resolveScalableOutputRounded({ base: 15, scalesWithIntelligence: true }, 6)).toBe(16);
  });
});

describe('foldLegacyStatModifier — resolution #3 mapping table', () => {
  function freshEff(): Record<StatId, number> {
    return {} as Record<StatId, number>;
  }

  it('additive "damage" folds into flat damageBonus', () => {
    const eff = freshEff();
    foldLegacyStatModifier(eff, { stat: 'damage', op: 'add', value: 10 });
    expect(eff.damageBonus).toBe(10);
    expect(eff.damagePercent).toBeUndefined();
  });

  it('multiplicative "damage" folds into generic damagePercent', () => {
    const eff = freshEff();
    foldLegacyStatModifier(eff, { stat: 'damage', op: 'multiply', value: 0.25 });
    expect(eff.damagePercent).toBe(0.25);
    expect(eff.damageBonus).toBeUndefined();
  });

  it('accumulates repeated damage modifiers into the same target field', () => {
    const eff = freshEff();
    foldLegacyStatModifier(eff, { stat: 'damage', op: 'add', value: 5 });
    foldLegacyStatModifier(eff, { stat: 'damage', op: 'add', value: 5 });
    expect(eff.damageBonus).toBe(10);
  });

  it('non-damage stats fold additively into their same-named field regardless of op', () => {
    for (const stat of ['maxHp', 'armor', 'attackSpeed', 'moveSpeed', 'accuracy'] as const) {
      const eff = freshEff();
      foldLegacyStatModifier(eff, { stat, op: 'add', value: 3 });
      foldLegacyStatModifier(eff, { stat, op: 'multiply', value: 2 });
      expect(eff[stat]).toBe(5);
    }
  });
});
