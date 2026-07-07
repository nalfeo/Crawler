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
import type { PrimaryStatId, SecondaryStatId, StatId } from '../shared/stats.js';
import type { EquipmentInstanceId, EquipmentState } from '../shared/equipment-types.js';
import type { GameWorld } from './world.js';

/**
 * Minimal structural shape of an equipped item for stat purposes: only its
 * flat `statBonuses` are consumed by the effective-stat formula. Accepting this
 * (rather than the full `EquipmentItemDef`) keeps the pure computation trivially
 * testable and lets callers build hypothetical loadouts.
 */
export interface StatBonusSource {
  readonly statBonuses: Partial<Readonly<Record<StatId, number>>>;
}

/**
 * Pure, world-free core of the effective-stat formula. Given an entity's base
 * stats, its allocated core-stat points, and the set of currently-equipped item
 * defs (already deduped to unique instances), return the full derived
 * EffectiveStats map. Performs no world reads/writes, so it is reusable for
 * "what-if" previews (see `equipmentSystem.previewEquipDelta`) without mutating
 * game state.
 *
 * Pipeline (order matters — mirrors the doc comment on `applyEffectiveStats`):
 *   1. start from base stats
 *   2. fold core-stat points into the effective PRIMARY stats
 *   3. add equipment bonuses (caller must pass unique instances only)
 *   4. derive SECONDARY stats from the effective primaries
 *   5. clamp every stat to its configured range
 */
export function computeEffectiveStatsFromLoadout(
  baseStats: Partial<Readonly<Record<StatId, number>>>,
  coreStatPoints: Partial<Readonly<Record<PrimaryStatId, number>>>,
  equippedDefs: Iterable<StatBonusSource>,
): Record<StatId, number> {
  const eff = {} as Record<StatId, number>;

  // 1. Start from base stats.
  for (const statId of ALL_STAT_IDS) {
    eff[statId] = baseStats[statId] ?? 0;
  }

  // 2. Fold level-up core-stat points into the effective primaries.
  for (const p of PRIMARY_STATS) {
    eff[p] += coreStatPoints[p] ?? 0;
  }

  // 3. Add equipment bonuses. The caller is responsible for passing unique
  //    instances so multi-slot items are not double-counted.
  for (const def of equippedDefs) {
    for (const [stat, bonus] of Object.entries(def.statBonuses)) {
      if (typeof bonus === 'number' && isValidStatId(stat)) {
        eff[stat] += bonus;
      }
    }
  }

  // 4. Derive secondaries from the (post-equipment) effective primaries.
  for (const p of PRIMARY_STATS) {
    const primaryValue = eff[p];
    const derived = CORE_STAT_TO_SECONDARY[p];
    for (const [secondary, rate] of Object.entries(derived) as [SecondaryStatId, number][]) {
      eff[secondary] += primaryValue * rate;
    }
  }

  // 5. Clamp every stat to its configured range.
  for (const statId of ALL_STAT_IDS) {
    eff[statId] = clampStat(statId, eff[statId]);
  }

  return eff;
}

/**
 * Collect the unique equipped item defs from an equipment state, deduping the
 * multi-slot items that occupy more than one slot. Shared by
 * `applyEffectiveStats` (the live loadout) and `previewEquipDelta` (the
 * hypothetical loadout) so the two can never drift.
 */
export function uniqueEquippedDefs(
  equipmentState: EquipmentState | undefined,
): Array<{ instanceId: EquipmentInstanceId } & StatBonusSource> {
  const defs: Array<{ instanceId: EquipmentInstanceId } & StatBonusSource> = [];
  if (!equipmentState) return defs;
  const seen = new Set<EquipmentInstanceId>();
  for (const slotId of Object.keys(equipmentState.equipped)) {
    const instId = equipmentState.equipped[slotId] ?? null;
    if (instId === null || seen.has(instId)) continue;
    seen.add(instId);
    const inst = equipmentState.instances.get(instId);
    if (!inst) continue;
    defs.push({ instanceId: instId, statBonuses: inst.def.statBonuses });
  }
  return defs;
}

/**
 * Recompute and write EffectiveStats for a single entity using the shared
 * formula. `equipmentState` is the entity's equipment side-map state (or
 * undefined if it has none). Delegates to `computeEffectiveStatsFromLoadout` so
 * the live and preview paths share one formula.
 */
export function applyEffectiveStats(
  world: GameWorld,
  entity: number,
  equipmentState: EquipmentState | undefined,
): void {
  const stores = world.stores;
  const base = {} as Record<StatId, number>;
  for (const statId of ALL_STAT_IDS) {
    base[statId] = stores.baseStats[statId][entity] ?? 0;
  }
  const core = {} as Record<PrimaryStatId, number>;
  for (const p of PRIMARY_STATS) {
    core[p] = stores.coreStatPoints[p][entity] ?? 0;
  }

  const eff = computeEffectiveStatsFromLoadout(base, core, uniqueEquippedDefs(equipmentState));

  for (const statId of ALL_STAT_IDS) {
    stores.effectiveStats[statId][entity] = eff[statId];
  }
}
