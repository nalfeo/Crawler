/**
 * Effective-stat computation — the single shared formula for deriving an
 * entity's `EffectiveStats` from its `BaseStats`, allocated level-up core-stat
 * points, and equipped items.
 *
 * Two callers share this so they can never drift:
 *   - `equipmentSystem.recomputeEffectiveStats` (eager, on equip/unequip)
 *   - `statSystem` (per-frame safety-net recompute, runs in the sim loop)
 *
 * Pipeline (order matters):
 *   1. start from BaseStats
 *   2. fold level-up core-stat points into the effective PRIMARY stats
 *   3. add equipment bonuses (unique instances only)
 *   4. derive SECONDARY stats from the effective primaries
 *      (see `CORE_STAT_TO_SECONDARY` — e.g. Luck → critChance, Dex → dodgeChance)
 *   5. clamp every stat to its configured range
 *
 * Step 2 + step 4 are the bridge that makes level-up allocation reach combat:
 * the damage path reads `critChance`/`dodgeChance` straight off EffectiveStats.
 */

import {
  ALL_STAT_IDS,
  PRIMARY_STATS,
  CORE_STAT_TO_SECONDARY,
  clampStat,
  isValidStatId,
} from '../shared/stats.js';
import type { SecondaryStatId } from '../shared/stats.js';
import type { EquipmentInstanceId, EquipmentState } from '../shared/equipment-types.js';
import type { GameWorld } from './world.js';

/**
 * Recompute and write EffectiveStats for a single entity using the shared
 * formula. `equipmentState` is the entity's equipment side-map state (or
 * undefined if it has none).
 */
export function applyEffectiveStats(
  world: GameWorld,
  entity: number,
  equipmentState: EquipmentState | undefined,
): void {
  const stores = world.stores;
  const eff = stores.effectiveStats;
  const base = stores.baseStats;
  const core = stores.coreStatPoints;

  // 1. Start from base stats.
  for (const statId of ALL_STAT_IDS) {
    eff[statId][entity] = base[statId][entity] ?? 0;
  }

  // 2. Fold level-up core-stat points into the effective primaries.
  for (const p of PRIMARY_STATS) {
    eff[p][entity] = (eff[p][entity] ?? 0) + (core[p][entity] ?? 0);
  }

  // 3. Add equipment bonuses (iterate unique instances to avoid double-counting
  //    multi-slot items).
  if (equipmentState) {
    const seenInstances = new Set<EquipmentInstanceId>();
    for (const slotId of Object.keys(equipmentState.equipped)) {
      const instId = equipmentState.equipped[slotId] ?? null;
      if (instId === null || seenInstances.has(instId)) continue;
      seenInstances.add(instId);
      const inst = equipmentState.instances.get(instId);
      if (!inst) continue;
      for (const [stat, bonus] of Object.entries(inst.def.statBonuses)) {
        if (typeof bonus === 'number' && isValidStatId(stat)) {
          eff[stat][entity] = (eff[stat][entity] ?? 0) + bonus;
        }
      }
    }
  }

  // 4. Derive secondaries from the (post-equipment) effective primaries.
  for (const p of PRIMARY_STATS) {
    const primaryValue = eff[p][entity] ?? 0;
    const derived = CORE_STAT_TO_SECONDARY[p];
    for (const [secondary, rate] of Object.entries(derived) as [SecondaryStatId, number][]) {
      eff[secondary][entity] = (eff[secondary][entity] ?? 0) + primaryValue * rate;
    }
  }

  // 5. Clamp every stat to its configured range.
  for (const statId of ALL_STAT_IDS) {
    eff[statId][entity] = clampStat(statId, eff[statId][entity] ?? 0);
  }
}
