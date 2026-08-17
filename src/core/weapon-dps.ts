import { WeaponType } from '../shared/constants.js';
import { applyAttackSpeedAndCooldownReduction, type StatId } from '../shared/stats.js';
import type { WeaponDef } from '../shared/weaponDefs.js';
import { computeExpectedCritDamage, computePlayerScaledDamage } from './combat-math.js';

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

function hitsPerActivation(def: WeaponDef): number {
  if (def.weaponType === WeaponType.BEAM) {
    const tickMs = Math.max(1, def.beamTickMs);
    // Mirrors the live pipeline: beams tick immediately on spawn, beamSystem runs
    // before lifetimeSystem, and lifetimeSystem removes at elapsed >= expiresAt,
    // so an exact boundary tick at durationMs is included.
    return Math.max(1, Math.floor(def.durationMs / tickMs) + 1);
  }

  return 1;
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
  const hitCount = hitsPerActivation(def);
  const expectedDamagePerActivation = expectedDamagePerHit * hitCount;
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
