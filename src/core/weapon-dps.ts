import { WeaponType } from '../shared/constants.js';
import { applyAttackSpeedAndCooldownReduction, type StatId } from '../shared/stats.js';
import type { WeaponDef } from '../shared/weaponDefs.js';
import {
  computeEffectiveAccuracyFromValues,
  computeExpectedCritDamage,
  computePlayerScaledDamage,
} from './combat-math.js';

type CombatStats = Readonly<Partial<Record<StatId, number>>>;

export interface TheoreticalWeaponDpsOptions {
  readonly attackSpeedMultiplier?: number;
}

export interface TheoreticalWeaponDps {
  readonly dps: number;
  readonly expectedDamagePerActivation: number;
  readonly effectiveCooldownMs: number;
  readonly hitsPerActivation: number;
}

export function computeTheoreticalSingleTargetDps(
  def: WeaponDef,
  stats: CombatStats,
  options: TheoreticalWeaponDpsOptions = {},
): TheoreticalWeaponDps {
  const attackSpeedMultiplier = options.attackSpeedMultiplier ?? 1;
  // Mirrors weaponSystem's damage metadata: only WeaponType.MAGIC uses magic
  // affinity; melee, ranged, thrown, beam, and trap attacks are physical.
  const affinity = def.weaponType === WeaponType.MAGIC ? 'magic' : 'physical';
  const expectedDamagePerHit = computeExpectedCritDamage(
    computePlayerScaledDamage(def.baseDamage, stats, {
      affinity,
      scaleWithPrimary: true,
    }),
    stats.critChance ?? 0,
    stats.critMultiplier ?? 1,
  );
  const hitCount = 1;
  const effectiveAccuracy = computeEffectiveAccuracyFromValues(
    def.weaponType,
    def.baseAccuracy,
    stats.accuracy ?? 0,
  );
  const expectedDamagePerActivation = expectedDamagePerHit * hitCount * effectiveAccuracy;
  if (attackSpeedMultiplier <= 0) {
    return {
      dps: 0,
      expectedDamagePerActivation,
      effectiveCooldownMs: Infinity,
      hitsPerActivation: hitCount,
    };
  }

  const baseCooldownMs = applyAttackSpeedAndCooldownReduction(
    def.cooldownMs,
    stats.attackSpeed ?? 0,
    stats.cooldownReduction ?? 0,
  );
  const effectiveCooldownMs = baseCooldownMs / attackSpeedMultiplier;
  const dps = expectedDamagePerActivation / (effectiveCooldownMs / 1000);

  return {
    dps: Number.isFinite(dps) ? dps : 0,
    expectedDamagePerActivation,
    effectiveCooldownMs,
    hitsPerActivation: hitCount,
  };
}
