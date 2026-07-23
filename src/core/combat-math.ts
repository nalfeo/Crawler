import { WeaponType, type WeaponTypeValue } from '../shared/constants.js';
import {
  computeTypedPrimaryMultiplier,
  type DamageAffinity,
  type StatId,
} from '../shared/stats.js';

type CombatStats = Readonly<Partial<Record<StatId, number>>>;

export interface PlayerDamageMathOptions {
  readonly affinity: DamageAffinity;
  readonly scaleWithPrimary: boolean;
}

/** Pure player-origin damage scaling shared by runtime damage and deterministic previews. */
export function computePlayerScaledDamage(
  baseAmount: number,
  stats: CombatStats,
  options: PlayerDamageMathOptions,
): number {
  const damageBonus = stats.damageBonus ?? 0;
  const damagePercent = stats.damagePercent ?? 0;
  let amount = Math.max(0, baseAmount + damageBonus) * (1 + Math.max(0, damagePercent));
  if (options.scaleWithPrimary) {
    amount *= computeTypedPrimaryMultiplier(
      options.affinity,
      stats.strength ?? 0,
      stats.intelligence ?? 0,
    );
  }
  return amount;
}

/** Expected value of the runtime crit roll, without sampling a realized outcome. */
export function computeExpectedCritDamage(
  amount: number,
  critChance: number,
  critMultiplier: number,
): number {
  const chance = Math.min(1, Math.max(0, critChance));
  const multiplier = critMultiplier > 0 ? critMultiplier : 1;
  return amount * (1 + chance * (multiplier - 1));
}

/** Runtime player armor contract: every unblocked incoming hit deals at least 1 damage. */
export function computeArmorReducedDamage(rawDamage: number, armor: number): number {
  return Math.max(1, rawDamage - armor);
}

/** Pure weapon hit chance shared by runtime firing and deterministic previews. */
export function computeEffectiveAccuracyFromValues(
  weaponType: WeaponTypeValue,
  baseAccuracy: number,
  accuracyBonus: number,
): number {
  if (weaponType === WeaponType.TRAP) return 1;
  return Math.min(1, Math.max(0, baseAccuracy + accuracyBonus));
}
