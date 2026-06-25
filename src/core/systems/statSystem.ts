/**
 * Stat System — per-frame stat aggregation.
 *
 * Recomputes `EffectiveStats` for every entity with Equipment + BaseStats using
 * the shared `applyEffectiveStats` formula (base stats + level-up core-stat
 * points + equipment + derived secondaries, clamped). Equipment changes also
 * recompute eagerly inside `equipmentSystem`; running this each frame in the sim
 * loop guarantees level-up core-stat allocation flows into combat-read stats
 * (crit/dodge) even when no equip event fired.
 *
 * Pure function: (world: GameWorld) => void — idempotent and deterministic.
 */

import { query } from 'bitecs';
import { Equipment, BaseStats, EffectiveStats } from '../components.js';
import type { GameWorld } from '../world.js';
import { applyEffectiveStats } from '../effective-stats.js';
import { getEquipmentState } from './equipmentSystem.js';

/**
 * Recompute EffectiveStats for all entities with Equipment + BaseStats.
 * Safe to call every frame — idempotent, deterministic.
 */
export function statSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Equipment, BaseStats, EffectiveStats]);
  for (const entity of entities) {
    applyEffectiveStats(world, entity, getEquipmentState(world, entity));
  }
}
