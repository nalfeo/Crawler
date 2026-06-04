import { query } from 'bitecs';
import { Player, Stats } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import {
  STAT_KEYS,
  STAT_BASE,
  STAT_POINT_INCREMENT,
  STAT_MIN,
  type StatKey,
} from '../../shared/stats.js';
import type { StatModifier } from '../skills/types.js';

/**
 * Recomputes final player stats from base + point bonuses + modifiers.
 * Only runs when world.statsDirty is true.
 *
 * Formula per stat:
 *   raw = base[stat] + (points[stat] * increment[stat]) + sum(add modifiers)
 *   final = clamp(min[stat], raw) * (1 + sum(multiply modifier values))
 */
export function statsSystem(world: GameWorld): void {
  if (!world.statsDirty) return;
  world.statsDirty = false;

  const players = query(world.ecs, [Player, Stats]);
  if (players.length === 0) return;

  const player = players[0]!;
  const frameCount = world.frameCount;

  // Filter out expired modifiers in-place
  world.statModifiers = world.statModifiers.filter(
    (m) => m.expiresFrame === undefined || m.expiresFrame > frameCount,
  );

  const { stores } = world;
  const pointsStore = stores.statPoints;

  for (const stat of STAT_KEYS) {
    const base = STAT_BASE[stat];
    const pointBonus = (pointsStore[stat][player] ?? 0) * STAT_POINT_INCREMENT[stat];

    let additive = 0;
    let multiplicative = 0;

    for (const mod of world.statModifiers) {
      if (mod.stat !== stat) continue;
      if (mod.op === 'add') {
        additive += mod.value;
      } else {
        multiplicative += mod.value;
      }
    }

    const raw = base + pointBonus + additive;
    const clamped = Math.max(STAT_MIN[stat], raw);
    stores.stats[stat][player] = clamped * (1 + multiplicative);
  }
}

/**
 * Distribute stat points to a player's statPoints store.
 * Used in tests and labs — UI layer calls this when player confirms allocation.
 * Marks statsDirty so statsSystem recomputes next frame.
 */
export function spendPoints(world: GameWorld, allocations: Partial<Record<StatKey, number>>): void {
  const players = query(world.ecs, [Player]);
  if (players.length === 0) return;

  const player = players[0]!;
  const pl = world.playerLevel;

  const totalSpent = Object.values(allocations).reduce((sum, n) => sum + (n ?? 0), 0);

  // Validate: all values must be non-negative integers
  for (const [stat, points] of Object.entries(allocations)) {
    const n = points ?? 0;
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `Invalid allocation for stat "${stat}": must be a non-negative integer, got ${n}`,
      );
    }
  }

  if (totalSpent > pl.unspentPoints) {
    throw new Error(`Cannot spend ${totalSpent} points — only ${pl.unspentPoints} available`);
  }

  for (const [statKey, points] of Object.entries(allocations) as [StatKey, number][]) {
    if (points > 0) {
      world.stores.statPoints[statKey][player] =
        (world.stores.statPoints[statKey][player] ?? 0) + points;
    }
  }

  pl.unspentPoints -= totalSpent;
  world.statsDirty = true;
}

/** Push a modifier and immediately dirty the stats. */
export function addStatModifier(world: GameWorld, mod: StatModifier): void {
  world.statModifiers.push(mod);
  world.statsDirty = true;
}

/** Remove all modifiers from a given source and dirty stats. */
export function removeStatModifiers(
  world: GameWorld,
  sourceType: StatModifier['sourceType'],
  sourceId: string,
): void {
  world.statModifiers = world.statModifiers.filter(
    (m) => !(m.sourceType === sourceType && m.sourceId === sourceId),
  );
  world.statsDirty = true;
}
