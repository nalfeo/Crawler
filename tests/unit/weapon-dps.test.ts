import { describe, expect, it } from 'vitest';
import { computeTheoreticalSingleTargetDps } from '../../src/core/weapon-dps.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';

function weapon(id: string) {
  const def = getWeaponDef(id);
  if (!def) throw new Error(`Missing weapon fixture: ${id}`);
  return def;
}

describe('computeTheoreticalSingleTargetDps', () => {
  it('combines weapon base damage with player damage, crit, and cadence stats', () => {
    const result = computeTheoreticalSingleTargetDps(weapon('sword'), {
      strength: 10,
      damageBonus: 2,
      damagePercent: 0.1,
      critChance: 0.25,
      critMultiplier: 2,
      attackSpeed: 0.2,
      cooldownReduction: 0.1,
    });

    expect(result.hitsPerActivation).toBe(1);
    expect(result.effectiveCooldownMs).toBe(450);
    expect(result.expectedDamagePerActivation).toBeCloseTo(25.7125);
    expect(result.dps).toBeCloseTo(57.1389);
  });

  it('uses current attack-speed status multipliers when provided', () => {
    const result = computeTheoreticalSingleTargetDps(
      weapon('sword'),
      {
        attackSpeed: 0.2,
        cooldownReduction: 0.1,
      },
      { attackSpeedMultiplier: 0.75 },
    );

    expect(result.effectiveCooldownMs).toBe(600);
    expect(result.dps).toBeCloseTo(25);
  });

  it('counts magic impact plus splash as single-target activation damage', () => {
    const result = computeTheoreticalSingleTargetDps(weapon('fireball'), {
      intelligence: 20,
    });

    expect(result.hitsPerActivation).toBe(2);
    expect(result.expectedDamagePerActivation).toBeCloseTo(19.2);
    expect(result.dps).toBeCloseTo(24);
  });

  it('counts beam ticks across the beam duration', () => {
    const result = computeTheoreticalSingleTargetDps(weapon('laser'), {});

    expect(result.hitsPerActivation).toBe(4);
    expect(result.expectedDamagePerActivation).toBe(12);
    expect(result.dps).toBeCloseTo(8);
  });
});
