/**
 * Effective-stat computation — the single shared formula for deriving an
 * entity's `EffectiveStats` from its `BaseStats`, allocated level-up core-stat
 * points, equipped items, and active ability/skill modifiers. `EffectiveStats`
 * is the sole runtime stat snapshot — there is no separate computed `Stats`
 * component; every consumer (damage, cadence, movement, UI) reads this store.
 *
 * Two callers share this so they can never drift:
 *   - `equipmentSystem.recomputeEffectiveStats` (eager, on equip/unequip)
 *   - `statSystem` (per-frame recompute + max-HP delta sync, runs in the sim loop)
 *
 * Pipeline (order matters):
 *   1. start from BaseStats
 *   2. fold level-up core-stat points into the effective PRIMARY stats
 *   3. add equipment bonuses (unique instances only)
 *   4. fold active ability/skill modifiers (legacy `StatModifier` shape —
 *      see `foldLegacyStatModifier`)
 *   5. derive SECONDARY stats from the effective primaries
 *      (see `CORE_STAT_TO_SECONDARY` — e.g. Luck → critChance, Dex → dodgeChance)
 *   6. clamp every stat to its configured range
 *
 * Step 2 + step 5 are the bridge that makes level-up allocation reach combat:
 * the damage path reads `critChance`/`dodgeChance` straight off EffectiveStats.
 * Strength and Intelligence deliberately do NOT feed a generic secondary here —
 * their per-point payoff is a typed-primary multiplier applied directly at
 * damage/spell resolution (see `shared/stats.ts#computeTypedPrimaryMultiplier`).
 */

import {
  ALL_STAT_IDS,
  PRIMARY_STATS,
  CORE_STAT_TO_SECONDARY,
  clampStat,
  isValidStatId,
  foldLegacyStatModifier,
  type LegacyStatModifierLike,
} from '../shared/stats.js';
import type { PrimaryStatId, SecondaryStatId, StatId } from '../shared/stats.js';
import type { EquipmentInstanceId, EquipmentState } from '../shared/equipment-types.js';
import type { GameWorld } from './world.js';
import { requireGeneratedEquipmentInstance } from './generated-equipment-registry.js';

/**
 * Minimal structural shape of an equipped item for stat purposes: its flat
 * `statBonuses` and `weightLb` are consumed by the effective-stat / encumbrance
 * formulas. Accepting this (rather than the full `EquipmentItemDef`) keeps the
 * pure computation trivially testable and lets callers build hypothetical
 * loadouts.
 */
export interface StatBonusSource {
  readonly statBonuses: Partial<Readonly<Record<StatId, number>>>;
  readonly weightLb: number;
}

/**
 * Pure, world-free core of the effective-stat formula. Given an entity's base
 * stats, its allocated core-stat points, the set of currently-equipped item
 * defs (already deduped to unique instances), and its active ability/skill
 * modifiers, return the full derived EffectiveStats map. Performs no world
 * reads/writes, so it is reusable for "what-if" previews (see
 * `equipmentSystem.previewEquipDelta`) without mutating game state.
 *
 * Pipeline (order matters — mirrors the doc comment on `applyEffectiveStats`):
 *   1. start from base stats
 *   2. fold core-stat points into the effective PRIMARY stats
 *   3. add equipment bonuses (caller must pass unique instances only)
 *   4. fold active modifiers (legacy StatModifier shape)
 *   5. derive SECONDARY stats from the effective primaries
 *   6. clamp every stat to its configured range
 */
export function computeEffectiveStatsFromLoadout(
  baseStats: Partial<Readonly<Record<StatId, number>>>,
  coreStatPoints: Partial<Readonly<Record<PrimaryStatId, number>>>,
  equippedDefs: Iterable<StatBonusSource>,
  activeModifiers: readonly LegacyStatModifierLike[] = [],
): Record<StatId, number> {
  return computeEffectiveStatsFromLoadoutInto(
    {} as Record<StatId, number>,
    baseStats,
    coreStatPoints,
    equippedDefs,
    activeModifiers,
  );
}

/**
 * Same semantics as `computeEffectiveStatsFromLoadout`, but writes into a
 * caller-supplied `target` record instead of allocating a fresh one. Used by
 * `applyEffectiveStats`'s hot per-frame path (statSystem) to avoid per-call
 * object churn. Every `StatId` slot in `target` is fully overwritten (never
 * additively OR'd with stale state), so the target is reusable across calls.
 * Returns `target` for call-site convenience.
 */
export function computeEffectiveStatsFromLoadoutInto(
  target: Record<StatId, number>,
  baseStats: Partial<Readonly<Record<StatId, number>>>,
  coreStatPoints: Partial<Readonly<Record<PrimaryStatId, number>>>,
  equippedDefs: Iterable<StatBonusSource>,
  activeModifiers: readonly LegacyStatModifierLike[] = [],
): Record<StatId, number> {
  // 1. Start from base stats. This overwrites every slot, wiping any residual
  //    value from a previous invocation when `target` is a reused scratch.
  for (const statId of ALL_STAT_IDS) {
    target[statId] = baseStats[statId] ?? 0;
  }

  // 2. Fold level-up core-stat points into the effective primaries.
  for (const p of PRIMARY_STATS) {
    target[p] += coreStatPoints[p] ?? 0;
  }

  // 3. Add equipment bonuses. The caller is responsible for passing unique
  //    instances so multi-slot items are not double-counted.
  for (const def of equippedDefs) {
    for (const [stat, bonus] of Object.entries(def.statBonuses)) {
      if (typeof bonus === 'number' && isValidStatId(stat)) {
        target[stat] += bonus;
      }
    }
  }

  // 4. Fold active ability/skill modifiers (legacy StatModifier shape).
  for (const mod of activeModifiers) {
    foldLegacyStatModifier(target, mod);
  }

  // 5. Derive secondaries from the (post-equipment/modifier) effective primaries.
  for (const p of PRIMARY_STATS) {
    const primaryValue = target[p];
    const derived = CORE_STAT_TO_SECONDARY[p];
    for (const [secondary, rate] of Object.entries(derived) as [SecondaryStatId, number][]) {
      target[secondary] += primaryValue * rate;
    }
  }

  // 6. Clamp every stat to its configured range.
  for (const statId of ALL_STAT_IDS) {
    target[statId] = clampStat(statId, target[statId]);
  }

  return target;
}

/**
 * Collect the unique equipped item defs from an equipment state, deduping the
 * multi-slot items that occupy more than one slot. Shared by
 * `applyEffectiveStats` (the live loadout) and `previewEquipDelta` (the
 * hypothetical loadout) so the two can never drift. Also the source of truth
 * for equipped weight (see `computeEquippedWeightLb`) — dedupe means a
 * two-handed weapon's `weightLb` counts once, not once per occupied slot.
 */
/**
 * Fill `target` with the unique equipped item defs from an equipment state,
 * deduping the multi-slot items that occupy more than one slot. Same semantics
 * as `uniqueEquippedDefs` but writes into a caller-supplied array + Set
 * instead of allocating fresh ones. Used by `applyEffectiveStats`'s hot
 * per-frame path (statSystem) to avoid per-call array/Set churn.
 *
 * Both `target` and `seen` are cleared before refill, so they are reusable
 * across calls. Returns `target` for call-site convenience.
 */
export function writeUniqueEquippedDefsInto(
  target: Array<{ instanceId: EquipmentInstanceId } & StatBonusSource>,
  seen: Set<EquipmentInstanceId>,
  world: GameWorld,
  equipmentState: EquipmentState | undefined,
): Array<{ instanceId: EquipmentInstanceId } & StatBonusSource> {
  target.length = 0;
  seen.clear();
  if (!equipmentState) return target;
  for (const slotId of Object.keys(equipmentState.equipped)) {
    const instId = equipmentState.equipped[slotId] ?? null;
    if (instId === null || seen.has(instId)) continue;
    seen.add(instId);
    if (typeof instId === 'number') {
      const inst = equipmentState.instances.get(instId);
      if (!inst) continue;
      target.push({
        instanceId: instId,
        statBonuses: inst.def.statBonuses,
        weightLb: inst.def.weightLb,
      });
    } else {
      const generated = requireGeneratedEquipmentInstance(world, instId);
      target.push({
        instanceId: instId,
        statBonuses: generated.frozen.statBonuses,
        weightLb: generated.frozen.weightLb,
      });
    }
  }
  return target;
}

export function uniqueEquippedDefs(
  world: GameWorld,
  equipmentState: EquipmentState | undefined,
): Array<{ instanceId: EquipmentInstanceId } & StatBonusSource> {
  const defs: Array<{ instanceId: EquipmentInstanceId } & StatBonusSource> = [];
  if (!equipmentState) return defs;
  const seen = new Set<EquipmentInstanceId>();
  for (const slotId of Object.keys(equipmentState.equipped)) {
    const instId = equipmentState.equipped[slotId] ?? null;
    if (instId === null || seen.has(instId)) continue;
    seen.add(instId);
    if (typeof instId === 'number') {
      const inst = equipmentState.instances.get(instId);
      if (!inst) continue;
      defs.push({
        instanceId: instId,
        statBonuses: inst.def.statBonuses,
        weightLb: inst.def.weightLb,
      });
    } else {
      const generated = requireGeneratedEquipmentInstance(world, instId);
      defs.push({
        instanceId: instId,
        statBonuses: generated.frozen.statBonuses,
        weightLb: generated.frozen.weightLb,
      });
    }
  }
  return defs;
}

/**
 * Sum of equipped gear weight (lb), deduped so a two-handed weapon or any
 * other multi-slot item counts its `weightLb` once. Bag/inventory contents
 * are excluded — only currently-equipped instances count. Combine with the
 * entity's `Weight` component (body mass) for total carried mass — see
 * `shared/encumbrance.ts`.
 */
export function computeEquippedWeightLb(
  world: GameWorld,
  equipmentState: EquipmentState | undefined,
): number {
  let total = 0;
  for (const def of uniqueEquippedDefs(world, equipmentState)) {
    total += def.weightLb;
  }
  return total;
}

/**
 * Recompute and write EffectiveStats for a single entity using the shared
 * formula. `equipmentState` is the entity's equipment side-map state (or
 * undefined if it has none). `activeModifiers` are the entity's currently
 * active (non-expired) ability/skill modifiers — pass `[]` when the caller
 * doesn't track any (e.g. non-player entities). Delegates to
 * `computeEffectiveStatsFromLoadoutInto` so the live and preview paths share
 * one formula.
 *
 * Uses reusable module-level scratch buffers for the base/core/eff records
 * and the deduped defs array/Set. This is safe because `applyEffectiveStats`
 * is only ever called from single-threaded, non-reentrant sim/equipment code:
 * statSystem's per-entity loop (reads from `_scratchEff` and writes to
 * `world.stores.effectiveStats` inside the same loop iteration before the
 * next call reuses the buffer), and equipmentSystem's eager equip/unequip
 * recompute (also a single call, not nested inside another applyEffectiveStats
 * invocation). The store write drains the scratch immediately, so subsequent
 * reuse never observes stale data.
 */
// Module-level scratch buffers, reused across applyEffectiveStats calls to
// avoid per-frame allocation (statSystem calls this every frame per equipped
// entity; each fresh object was pure GC pressure).
const _scratchBase = {} as Record<StatId, number>;
const _scratchCore = {} as Record<PrimaryStatId, number>;
const _scratchEff = {} as Record<StatId, number>;
const _scratchDefs: Array<{ instanceId: EquipmentInstanceId } & StatBonusSource> = [];
const _scratchSeen = new Set<EquipmentInstanceId>();

export function applyEffectiveStats(
  world: GameWorld,
  entity: number,
  equipmentState: EquipmentState | undefined,
  activeModifiers: readonly LegacyStatModifierLike[] = [],
): void {
  const stores = world.stores;
  for (const statId of ALL_STAT_IDS) {
    _scratchBase[statId] = stores.baseStats[statId][entity] ?? 0;
  }
  for (const p of PRIMARY_STATS) {
    _scratchCore[p] = stores.coreStatPoints[p][entity] ?? 0;
  }

  computeEffectiveStatsFromLoadoutInto(
    _scratchEff,
    _scratchBase,
    _scratchCore,
    writeUniqueEquippedDefsInto(_scratchDefs, _scratchSeen, world, equipmentState),
    activeModifiers,
  );

  for (const statId of ALL_STAT_IDS) {
    stores.effectiveStats[statId][entity] = _scratchEff[statId];
  }
}
