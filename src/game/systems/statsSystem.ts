import { hasComponent, query } from 'bitecs';
import { Health, Player, Stats } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import {
  PRIMARY_STATS,
  STAT_KEYS,
  STAT_BASE,
  STAT_MIN,
  CORE_STAT_GAINS,
  isAllocatablePrimaryStat,
  type PrimaryStatId,
} from '../../shared/stats.js';
import type { StatModifier } from '../skills/types.js';

/**
 * Recomputes final player stats from base + core-stat-point bonuses + modifiers.
 * Only runs when world.statsDirty is true.
 *
 * Formula per STAT_KEYS entry:
 *   raw = STAT_BASE[key]
 *         + (Σ coreStatPoints[p] × CORE_STAT_GAINS[p][key])   // level-up points
 *         + Σ additive modifiers[key]
 *   final = clamp(min, raw) * (1 + Σ multiplicative modifiers[key])
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
  const corePoints = stores.coreStatPoints;

  // Capture the previous computed maxHp *stat* before the loop overwrites it,
  // so we can sync the change through to the Health.max component as a delta.
  const prevRawMaxHp = stores.stats.maxHp[player] ?? 0;
  const prevMaxHp = prevRawMaxHp > 0 ? prevRawMaxHp : STAT_BASE.maxHp;

  for (const key of STAT_KEYS) {
    const base = STAT_BASE[key];

    // Accumulate per-point core-stat contributions.
    let coreBonus = 0;
    for (const p of PRIMARY_STATS) {
      const gain = CORE_STAT_GAINS[p][key];
      if (gain !== undefined) {
        coreBonus += (corePoints[p][player] ?? 0) * gain;
      }
    }

    let additive = 0;
    let multiplicative = 0;
    for (const mod of world.statModifiers) {
      if (mod.stat !== key) continue;
      if (mod.op === 'add') {
        additive += mod.value;
      } else {
        multiplicative += mod.value;
      }
    }

    const raw = base + coreBonus + additive;
    const clamped = Math.max(STAT_MIN[key], raw);
    stores.stats[key][player] = clamped * (1 + multiplicative);
  }

  // Wire maxHp stat change through to Health.max (delta preserves other HP sources).
  if (hasComponent(world.ecs, player, Health)) {
    const newMaxHp = stores.stats.maxHp[player] ?? STAT_BASE.maxHp;
    const delta = newMaxHp - prevMaxHp;
    if (delta !== 0) {
      const currentMax = stores.health.max[player] ?? STAT_BASE.maxHp;
      const nextMax = Math.max(1, currentMax + delta);
      stores.health.max[player] = nextMax;
      const currentHp = stores.health.current[player] ?? 0;
      if (delta > 0) {
        stores.health.current[player] = currentHp + delta;
      } else {
        stores.health.current[player] = Math.min(currentHp, nextMax);
      }
    }
  }

  world.statsDirty = false;
}

/**
 * Distribute core stat points to a player's coreStatPoints store.
 * Used in tests, labs, and the UI layer when the player confirms allocation.
 * Marks statsDirty so statsSystem recomputes next frame.
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
