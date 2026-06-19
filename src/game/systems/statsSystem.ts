import { hasComponent, query } from 'bitecs';
import { Health, Player, Stats } from '../../core/components.js';
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
  const frameCount = world.frameCount;
  const activeModifiers = world.statModifiers.filter(
    (m) => m.expiresFrame === undefined || m.expiresFrame > frameCount,
  );
  if (activeModifiers.length !== world.statModifiers.length) {
    world.statModifiers = activeModifiers;
    world.statsDirty = true;
  }

  if (!world.statsDirty) return;

  const players = query(world.ecs, [Player, Stats]);
  if (players.length === 0) return;

  const player = players[0]!;

  const { stores } = world;
  const pointsStore = stores.statPoints;

  // Capture the previous computed maxHp *stat* before the loop overwrites it,
  // so we can sync the change through to the Health.max component as a delta.
  // Default to STAT_BASE.maxHp when the store is still uninitialised (0) so the
  // very first compute does not spuriously shove +base into the HP pool.
  const prevRawMaxHp = stores.stats.maxHp[player] ?? 0;
  const prevMaxHp = prevRawMaxHp > 0 ? prevRawMaxHp : STAT_BASE.maxHp;

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

  // Wire the computed maxHp stat through to the Health.max component. statsSystem
  // owns the maxHp *stat*, but combat, healing, and the AI retreat logic all read
  // Health.max — so without this sync, allocating or buffing maxHp is a no-op for
  // the actual HP pool (the original bug). Apply it as a delta so it composes
  // additively with other Health.max sources (e.g. per-floor HP bonuses) and only
  // moves the pool by the amount the stat itself changed.
  if (hasComponent(world.ecs, player, Health)) {
    const newMaxHp = stores.stats.maxHp[player] ?? STAT_BASE.maxHp;
    const delta = newMaxHp - prevMaxHp;
    if (delta !== 0) {
      const currentMax = stores.health.max[player] ?? STAT_BASE.maxHp;
      const nextMax = Math.max(1, currentMax + delta);
      stores.health.max[player] = nextMax;
      const currentHp = stores.health.current[player] ?? 0;
      if (delta > 0) {
        // Gaining max HP grants the extra HP immediately (RPG convention) so the
        // boost aids survival right away, not only after the next heal tick.
        stores.health.current[player] = currentHp + delta;
      } else {
        // Losing max HP (e.g. an expiring +maxHp buff) must not leave current HP
        // above the new ceiling.
        stores.health.current[player] = Math.min(currentHp, nextMax);
      }
    }
  }

  world.statsDirty = false;
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
  let totalSpent = 0;

  // Validate: all values must be non-negative integers
  for (const [stat, points] of Object.entries(allocations)) {
    if (!STAT_KEYS.includes(stat as StatKey)) {
      throw new Error(`Invalid allocation key "${stat}": expected one of ${STAT_KEYS.join(', ')}`);
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

  for (const [rawStatKey, points] of Object.entries(allocations)) {
    const statKey = rawStatKey as StatKey;
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
