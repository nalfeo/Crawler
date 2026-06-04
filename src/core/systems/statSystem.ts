/**
 * Stat System — per-frame stat aggregation.
 *
 * In v1, stat recomputation is done eagerly on every equip/unequip inside
 * equipmentSystem. This system exists as a safety net that can be run each
 * frame to ensure EffectiveStats stores are always consistent.
 *
 * Pure function: (world: GameWorld) => void
 */

import { query } from 'bitecs';
import { Equipment, BaseStats, EffectiveStats } from '../components.js';
import type { GameWorld } from '../world.js';
import { ALL_STAT_IDS, clampStat, isValidStatId } from '../../shared/stats.js';
import type { EquipmentInstanceId } from '../../shared/equipment-types.js';
import { getEquipmentState } from './equipmentSystem.js';

/**
 * Recompute EffectiveStats for all entities with Equipment + BaseStats.
 * Safe to call every frame — idempotent, deterministic.
 */
export function statSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Equipment, BaseStats, EffectiveStats]);
  const stores = world.stores;

  for (const entity of entities) {
    // Start from base
    for (const statId of ALL_STAT_IDS) {
      stores.effectiveStats[statId][entity] = stores.baseStats[statId][entity] ?? 0;
    }

    // Add equipment bonuses (unique instances only)
    const eqState = getEquipmentState(world, entity);
    if (eqState) {
      const seenInstances = new Set<EquipmentInstanceId>();
      for (const slotId of Object.keys(eqState.equipped)) {
        const instId = eqState.equipped[slotId] ?? null;
        if (instId === null || seenInstances.has(instId)) continue;
        seenInstances.add(instId);
        const inst = eqState.instances.get(instId);
        if (!inst) continue;
        for (const [stat, bonus] of Object.entries(inst.def.statBonuses)) {
          if (typeof bonus === 'number' && isValidStatId(stat)) {
            stores.effectiveStats[stat][entity] =
              (stores.effectiveStats[stat][entity] ?? 0) + bonus;
          }
        }
      }
    }

    // Clamp
    for (const statId of ALL_STAT_IDS) {
      stores.effectiveStats[statId][entity] = clampStat(
        statId,
        stores.effectiveStats[statId][entity] ?? 0,
      );
    }
  }
}
