import type { GameWorld } from '../../core/index.js';
import type { PrimaryStatId } from '../../shared/stats.js';

/**
 * Deterministic survival-tiered auto-allocation policy shared by headless
 * progression and Floor 2's direct-start preset.
 *
 * Spend order front-loads sustain:
 *   1. Strength -> 5 armor
 *   2. Constitution -> +60 HP
 *   3. Strength -> 11 armor
 *   4. Constitution for the remainder
 */
const ARMOR_SWARM_FLOOR = 5;
const MAXHP_CUSHION_POINTS = 6;
const ARMOR_BOSS_TARGET = 11;

export function computeAutoStatAllocation(
  world: GameWorld,
  playerEid: number,
  available: number,
): Partial<Record<PrimaryStatId, number>> {
  const allocation: Partial<Record<PrimaryStatId, number>> = {};
  let remaining = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 0;
  if (remaining <= 0) {
    return allocation;
  }

  const spendStrengthUpTo = (target: number): void => {
    const current =
      (world.stores.coreStatPoints.strength[playerEid] ?? 0) + (allocation.strength ?? 0);
    const spend = Math.min(Math.max(0, target - current), remaining);
    if (spend > 0) {
      allocation.strength = (allocation.strength ?? 0) + spend;
      remaining -= spend;
    }
  };

  const spendConstitutionUpTo = (targetPoints: number): void => {
    const current =
      (world.stores.coreStatPoints.constitution[playerEid] ?? 0) + (allocation.constitution ?? 0);
    const spend = Math.min(Math.max(0, targetPoints - current), remaining);
    if (spend > 0) {
      allocation.constitution = (allocation.constitution ?? 0) + spend;
      remaining -= spend;
    }
  };

  spendStrengthUpTo(ARMOR_SWARM_FLOOR);
  spendConstitutionUpTo(MAXHP_CUSHION_POINTS);
  spendStrengthUpTo(ARMOR_BOSS_TARGET);
  if (remaining > 0) {
    allocation.constitution = (allocation.constitution ?? 0) + remaining;
  }

  return allocation;
}
