import { getActiveWeaponDef, type GameWorld } from '../../core/index.js';
import { WeaponType } from '../../shared/constants.js';
import type { PrimaryStatId } from '../../shared/stats.js';

/**
 * Deterministic survival-tiered auto-allocation policy shared by headless
 * progression and Floor 2's direct-start preset.
 *
 * Spend order (stat-system overhaul, plan resolution #11) shares the same
 * CON/DEX/WIS logic regardless of weapon and ONLY changes which primary stat
 * "offense" spends into — Strength for a physical weapon, Intelligence for a
 * magic one (`WeaponType.MAGIC`, e.g. the starter fireball wand):
 *   1. Offense -> 5
 *   2. Constitution -> 6
 *   3. Dexterity -> 5
 *   4. Wisdom -> 5
 *   5. Offense -> 11
 *   6. Constitution for the remainder
 *
 * Weapon personas (see `game/ai/weapon-personas.ts`) stay disabled by default
 * and take over via `computeAiStatAllocation`'s branch — this function is the
 * shared/default path exercised whenever personas are off.
 */
const OFFENSE_FLOOR_TARGET = 5;
const CON_CUSHION_TARGET = 6;
const DEX_TARGET = 5;
const WIS_TARGET = 5;
const OFFENSE_BOSS_TARGET = 11;

/** Physical weapons spend offense points into Strength; magic ones into Intelligence. */
function getOffenseStat(world: GameWorld): PrimaryStatId {
  const activeWeapon = getActiveWeaponDef(world);
  return activeWeapon?.weaponType === WeaponType.MAGIC ? 'intelligence' : 'strength';
}

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

  const offenseStat = getOffenseStat(world);

  const spendUpTo = (stat: PrimaryStatId, target: number): void => {
    const current = (world.stores.coreStatPoints[stat][playerEid] ?? 0) + (allocation[stat] ?? 0);
    const spend = Math.min(Math.max(0, target - current), remaining);
    if (spend > 0) {
      allocation[stat] = (allocation[stat] ?? 0) + spend;
      remaining -= spend;
    }
  };

  spendUpTo(offenseStat, OFFENSE_FLOOR_TARGET);
  spendUpTo('constitution', CON_CUSHION_TARGET);
  spendUpTo('dexterity', DEX_TARGET);
  spendUpTo('wisdom', WIS_TARGET);
  spendUpTo(offenseStat, OFFENSE_BOSS_TARGET);
  if (remaining > 0) {
    allocation.constitution = (allocation.constitution ?? 0) + remaining;
  }

  return allocation;
}
