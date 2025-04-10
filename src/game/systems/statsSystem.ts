/**
 * Level-up + ability/skill modifier allocation APIs.
 *
 * There is no computational "statsSystem" anymore — `EffectiveStats` is the
 * sole runtime stat snapshot, recomputed every frame by the core `statSystem`
 * (`src/core/systems/statSystem.ts`) directly from BaseStats + CoreStatPoints
 * + equipment + these same active `world.statModifiers` (folded via
 * `shared/stats.ts#foldLegacyStatModifier`). This module keeps the
 * allocation-side APIs — spending level-up points and registering/removing
 * ability/skill modifiers — as a compatible export so callers (level-up UI,
 * abilities, skills) don't need to know about that merge.
 */
import { query } from 'bitecs';
import { Player } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { PRIMARY_STATS, isAllocatablePrimaryStat, type PrimaryStatId } from '../../shared/stats.js';
import type { StatModifier } from '../skills/types.js';

/**
 * Distribute core stat points to a player's coreStatPoints store.
 * Used in tests, labs, and the UI layer when the player confirms allocation.
 * `statSystem` recomputes EffectiveStats from these every frame automatically.
 */
export function spendPoints(
  world: GameWorld,
  allocations: Partial<Record<PrimaryStatId, number>>,
): void {
  const players = query(world.ecs, [Player]);
  if (players.length === 0) return;

  const player = players[0]!;
  const pl = world.playerLevel;
  let totalSpent = 0;

  // Validate: all values must be non-negative integers for valid PRIMARY_STATS keys.
  for (const [stat, points] of Object.entries(allocations)) {
    if (!PRIMARY_STATS.includes(stat as PrimaryStatId)) {
      throw new Error(
        `Invalid allocation key "${stat}": expected one of ${PRIMARY_STATS.join(', ')}`,
      );
    }
    if ((points ?? 0) > 0 && !isAllocatablePrimaryStat(stat as PrimaryStatId)) {
      throw new Error(`Stat "${stat}" cannot be allocated via level-up points`);
    }
    const n = points ?? 0;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new Error(
        `Invalid allocation for stat "${stat}": must be a non-negative integer, got ${n}`,
      );
    }
    totalSpent += n;
  }

  if (totalSpent > pl.unspentPoints) {
    throw new Error(`Cannot spend ${totalSpent} points — only ${pl.unspentPoints} available`);
  }

  for (const [rawStat, points] of Object.entries(allocations)) {
    const stat = rawStat as PrimaryStatId;
    if ((points ?? 0) > 0) {
      world.stores.coreStatPoints[stat][player] =
        (world.stores.coreStatPoints[stat][player] ?? 0) + (points ?? 0);
    }
  }

  pl.unspentPoints -= totalSpent;
}

/** Push a modifier. `statSystem` folds active (non-expired) modifiers every frame. */
export function addStatModifier(world: GameWorld, mod: StatModifier): void {
  world.statModifiers.push(mod);
}

/** Remove all modifiers from a given source. */
export function removeStatModifiers(
  world: GameWorld,
  sourceType: StatModifier['sourceType'],
  sourceId: string,
): void {
  world.statModifiers = world.statModifiers.filter(
    (m) => !(m.sourceType === sourceType && m.sourceId === sourceId),
  );
}
