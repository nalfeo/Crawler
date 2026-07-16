/**
 * Equipment System — pure functions for equip/unequip/canEquip.
 *
 * Uses WeakMap side-map pattern (same as weaponSystem.ts).
 * Equipment state is per-entity, stored outside ECS typed arrays.
 * Stat recomputation writes results into EffectiveStats typed-array store.
 */

import { addComponent, hasComponent, removeComponent, setComponent } from 'bitecs';
import { Equipment, BaseStats, EffectiveStats, Health, Player } from '../components.js';
import type { GameWorld } from '../world.js';
import { syncHealthFromDerivedMaxHpDelta } from '../derived-max-hp.js';
import { SLOT_REGISTRY, isValidSlotId } from '../../shared/equipment-slots.js';
import type { EquipmentSlotId } from '../../shared/equipment-slots.js';
import {
  ALL_STAT_IDS,
  isValidStatId,
  DEFAULT_BASE_STATS,
  PRIMARY_STATS,
} from '../../shared/stats.js';
import type { PrimaryStatId, StatId } from '../../shared/stats.js';
import {
  applyEffectiveStats,
  computeEffectiveStatsFromLoadout,
  uniqueEquippedDefs,
} from '../effective-stats.js';
import type { StatBonusSource } from '../effective-stats.js';
import type {
  EquipmentItemDef,
  EquipmentInstanceId,
  EquipmentInstance,
  EquipmentState,
  EquipResult,
  UnequipResult,
  CanEquipResult,
  EquipFailureReason,
} from '../../shared/equipment-types.js';
import { isInSafeContext } from '../safe-space.js';
import { applyStatusEffect, clearStatusEffects, isValidSpec } from '../status-effects.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { setActiveWeaponDef, clearActiveWeaponDef } from '../active-weapon.js';
import { getEquipmentDefForItem } from '../../shared/equipmentDefs.js';
import { addItem, removeItem, hasItem } from '../../shared/inventory.js';

// --- Side-map storage ---

const equipmentStates = new WeakMap<GameWorld, Map<number, EquipmentState>>();
const entityTags = new WeakMap<GameWorld, Map<number, Set<string>>>();
const instanceCounters = new WeakMap<GameWorld, { next: number }>();
const customRequirements = new WeakMap<
  GameWorld,
  Map<string, (world: GameWorld, entity: number, itemDef: EquipmentItemDef) => boolean>
>();

function getEquipmentMap(world: GameWorld): Map<number, EquipmentState> {
  let map = equipmentStates.get(world);
  if (!map) {
    map = new Map();
    equipmentStates.set(world, map);
  }
  return map;
}

function getEntityTagMap(world: GameWorld): Map<number, Set<string>> {
  let map = entityTags.get(world);
  if (!map) {
    map = new Map();
    entityTags.set(world, map);
  }
  return map;
}

function getNextInstanceId(world: GameWorld): EquipmentInstanceId {
  let counter = instanceCounters.get(world);
  if (!counter) {
    counter = { next: 1 };
    instanceCounters.set(world, counter);
  }
  return counter.next++;
}

function getCustomRequirements(
  world: GameWorld,
): Map<string, (world: GameWorld, entity: number, itemDef: EquipmentItemDef) => boolean> {
  let map = customRequirements.get(world);
  if (!map) {
    map = new Map();
    customRequirements.set(world, map);
  }
  return map;
}

// --- State management ---

function createEmptyState(): EquipmentState {
  const equipped: Record<EquipmentSlotId, EquipmentInstanceId | null> = {};
  for (const slot of SLOT_REGISTRY) {
    equipped[slot.id] = null;
  }
  return {
    equipped,
    instances: new Map(),
    disabledSlots: new Set(),
  };
}

function getOrCreateState(world: GameWorld, entity: number): EquipmentState {
  const map = getEquipmentMap(world);
  let state = map.get(entity);
  if (!state) {
    state = createEmptyState();
    map.set(entity, state);
  }
  return state;
}

// --- Stat recomputation ---

function recomputeEffectiveStats(world: GameWorld, entity: number): void {
  const prevDerivedMaxHp = hasComponent(world.ecs, entity, Health)
    ? (world.stores.effectiveStats.maxHp[entity] ?? 0)
    : 0;
  // Fold currently-active (non-expired) modifiers so an eager equip/unequip
  // recompute matches what the next statSystem tick would produce — keeps the
  // two callers of applyEffectiveStats from ever disagreeing mid-frame.
  const activeModifiers = world.statModifiers.filter(
    (m) => m.expiresFrame === undefined || m.expiresFrame > world.frameCount,
  );
  applyEffectiveStats(world, entity, getEquipmentMap(world).get(entity), activeModifiers);
  syncHealthFromDerivedMaxHpDelta(world, entity, prevDerivedMaxHp);
}

// --- Validation ---

function validateItemDef(itemDef: EquipmentItemDef): EquipFailureReason[] {
  const reasons: EquipFailureReason[] = [];

  if (!itemDef.slots || itemDef.slots.length === 0) {
    reasons.push({ type: 'invalidDef', message: 'Item must have at least one slot' });
  }

  const seenSlots = new Set<string>();
  for (const slotId of itemDef.slots) {
    if (seenSlots.has(slotId)) {
      reasons.push({ type: 'invalidDef', message: `Duplicate slot: ${slotId}` });
    }
    seenSlots.add(slotId);
  }

  for (const slotId of itemDef.slots) {
    if (!isValidSlotId(slotId)) {
      reasons.push({ type: 'unknownSlot', slotId });
    }
  }

  for (const [stat, value] of Object.entries(itemDef.statBonuses)) {
    if (!isValidStatId(stat)) {
      reasons.push({ type: 'invalidDef', message: `Unknown stat: ${stat}` });
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      reasons.push({ type: 'invalidDef', message: `Non-finite value for stat: ${stat}` });
      continue;
    }

    if ((PRIMARY_STATS as readonly string[]).includes(stat) && !Number.isInteger(value)) {
      reasons.push({
        type: 'invalidDef',
        message: `Primary stat ${stat} must be integer, got ${value}`,
      });
    }
  }

  if (!Number.isFinite(itemDef.weightLb) || itemDef.weightLb < 0) {
    reasons.push({
      type: 'invalidDef',
      message: `Invalid weightLb: must be a finite non-negative number, got ${itemDef.weightLb}`,
    });
  }

  for (const spec of itemDef.grantsStatusEffects ?? []) {
    if (!isValidSpec(spec)) {
      reasons.push({
        type: 'invalidDef',
        message: `Invalid status-effect spec (stat: ${spec.stat}, op: ${spec.op})`,
      });
    }
  }

  return reasons;
}

// --- Requirement evaluation ---

function evaluateRequirements(
  world: GameWorld,
  entity: number,
  itemDef: EquipmentItemDef,
  statsOverride?: Readonly<Record<StatId, number>>,
): EquipFailureReason[] {
  if (!itemDef.requirements || itemDef.requirements.length === 0) return [];
  const reasons: EquipFailureReason[] = [];
  const stores = world.stores;
  const tags = getEntityTagMap(world).get(entity);

  for (const req of itemDef.requirements) {
    switch (req.type) {
      case 'minLevel': {
        // Level not yet implemented — treat as always-pass for now
        // When Level component exists, check stores.level.current[entity]
        break;
      }
      case 'maxLevel': {
        break;
      }
      case 'minStat': {
        // When a statsOverride is supplied (a hypothetical post-swap loadout),
        // evaluate the requirement against it instead of the live effective
        // stats — this is what lets equipFromBag/previewEquipDelta check a new
        // item's requirement on the basis that will actually exist once the
        // items it displaces are unequipped.
        const current = statsOverride
          ? (statsOverride[req.stat] ?? 0)
          : (stores.effectiveStats[req.stat]?.[entity] ?? 0);
        if (current < req.value) {
          reasons.push({
            type: 'requirementFailed',
            requirement: req,
            message: `Requires ${req.stat} ≥ ${req.value}, have ${current}`,
          });
        }
        break;
      }
      case 'hasTag': {
        if (!tags?.has(req.tag)) {
          reasons.push({
            type: 'requirementFailed',
            requirement: req,
            message: `Requires tag: ${req.tag}`,
          });
        }
        break;
      }
      case 'notTag': {
        if (tags?.has(req.tag)) {
          reasons.push({
            type: 'requirementFailed',
            requirement: req,
            message: `Incompatible with tag: ${req.tag}`,
          });
        }
        break;
      }
      case 'custom': {
        const predicate = getCustomRequirements(world).get(req.id);
        if (predicate && !predicate(world, entity, itemDef)) {
          reasons.push({
            type: 'requirementFailed',
            requirement: req,
            message: `Custom requirement failed: ${req.id}`,
          });
        }
        break;
      }
    }
  }

  return reasons;
}

// --- Swap feasibility (shared by equipFromBag + previewEquipDelta) ---

/**
 * Feasibility of equipping `def` on `entity` as a Diablo-style SWAP — i.e. after
 * the items currently occupying `def.slots` are unequipped. The new item's
 * requirements are evaluated against the POST-UNEQUIP stat basis (base + core
 * points + the *retained* equipped items, WITHOUT `def`'s own bonuses), which is
 * exactly the basis `equip`'s `canEquip` will see once the target slots are
 * freed. Occupied-slot blockers are intentionally excluded because the swap
 * frees those slots. Returns the blocking reasons — empty ⇒ the swap's forward
 * `equip` is guaranteed to succeed.
 *
 * Shared by two callers so they can never disagree:
 *   - `equipFromBag` uses it as a PRE-MUTATION gate, making the swap atomic:
 *     an infeasible swap is refused before the bag/equipment are touched, so no
 *     item can be removed-then-lost in a failed rollback.
 *   - `previewEquipDelta` uses it for `canEquip`, so the inspector's "can equip"
 *     verdict matches what the real equip will do (a requirement met only by the
 *     very item being displaced correctly reads as NOT equippable).
 */
function swapEquipFailureReasons(
  world: GameWorld,
  entity: number,
  def: EquipmentItemDef,
): EquipFailureReason[] {
  const state = getEquipmentState(world, entity);

  const base = {} as Record<StatId, number>;
  for (const statId of ALL_STAT_IDS) {
    base[statId] = world.stores.baseStats[statId][entity] ?? 0;
  }
  const core = {} as Record<PrimaryStatId, number>;
  for (const p of PRIMARY_STATS) {
    core[p] = world.stores.coreStatPoints[p][entity] ?? 0;
  }

  // Instances currently occupying the new item's slots — these get unequipped
  // by the swap, so their stat bonuses must NOT count toward the requirement.
  const swappedInstanceIds = new Set<EquipmentInstanceId>();
  if (state) {
    for (const slotId of def.slots) {
      if (!isValidSlotId(slotId)) continue;
      const instId = state.equipped[slotId] ?? null;
      if (instId !== null) swappedInstanceIds.add(instId);
    }
  }
  const postUnequipSources: StatBonusSource[] = uniqueEquippedDefs(state)
    .filter((d) => !swappedInstanceIds.has(d.instanceId))
    .map((d) => ({ statBonuses: d.statBonuses, weightLb: d.weightLb }));
  const postUnequipStats = computeEffectiveStatsFromLoadout(base, core, postUnequipSources);

  return [...validateItemDef(def), ...evaluateRequirements(world, entity, def, postUnequipStats)];
}

// --- Public API ---

interface EquipOptions {
  /** Skip world.state check — for labs and tests. */
  force?: boolean;
}

/** Initialize base stats for an entity. Must be called before using stat system. */
export function initializeBaseStats(
  world: GameWorld,
  entity: number,
  overrides?: Partial<Record<StatId, number>>,
): void {
  const stats = { ...DEFAULT_BASE_STATS, ...overrides };
  addComponent(world.ecs, entity, BaseStats);
  addComponent(world.ecs, entity, EffectiveStats);
  addComponent(world.ecs, entity, Equipment);

  for (const statId of ALL_STAT_IDS) {
    setComponent(world.ecs, entity, BaseStats, { [statId]: stats[statId] });
    world.stores.baseStats[statId][entity] = stats[statId];
  }

  // Ensure equipment state exists
  getOrCreateState(world, entity);

  recomputeEffectiveStats(world, entity);

  // Seed Health.max/current to the freshly derived max HP (e.g. base CON = 1,
  // no allocation/gear yet, starts full at 160 + 10*1 = 170 — see
  // shared/stats.ts#BASE_MAX_HP_FLOOR). This is spawn-time seeding, not a
  // per-frame sync — statSystem's delta-based sync (capture-before-overwrite)
  // takes over every frame after this and can never creep max HP because the
  // very first tick sees prevMaxHp === newMaxHp.
  if (hasComponent(world.ecs, entity, Health)) {
    const derivedMaxHp = world.stores.effectiveStats.maxHp[entity] ?? 0;
    if (derivedMaxHp > 0) {
      setComponent(world.ecs, entity, Health, { max: derivedMaxHp, current: derivedMaxHp });
    }
  }
}

/** Set entity tags (for hasTag/notTag requirements). */
export function setEntityTags(world: GameWorld, entity: number, tags: string[]): void {
  getEntityTagMap(world).set(entity, new Set(tags));
}

/** Register a custom equip requirement predicate. Must be pure and deterministic. */
export function registerCustomRequirement(
  world: GameWorld,
  id: string,
  predicate: (world: GameWorld, entity: number, itemDef: EquipmentItemDef) => boolean,
): void {
  getCustomRequirements(world).set(id, predicate);
}

/** Check if an item can be equipped — returns allowed + reasons. */
export function canEquip(
  world: GameWorld,
  entity: number,
  itemDef: EquipmentItemDef,
): CanEquipResult {
  const reasons: EquipFailureReason[] = [];

  // Validation
  reasons.push(...validateItemDef(itemDef));

  // Slot availability (only if validation passed for slot checks)
  const state = getOrCreateState(world, entity);
  for (const slotId of itemDef.slots) {
    if (isValidSlotId(slotId) && state.equipped[slotId] !== null) {
      reasons.push({ type: 'occupiedSlot', slotId });
    }
  }

  // Requirements
  reasons.push(...evaluateRequirements(world, entity, itemDef));

  return { allowed: reasons.length === 0, reasons };
}

/** Runtime status-effect sourceId for an equipped instance (see equip/unequip). */
function equipmentSourceId(instanceId: EquipmentInstanceId): string {
  return `equipment:${instanceId}`;
}

/** Equip an item. Atomic — either fully succeeds or no state change. */
export function equip(
  world: GameWorld,
  entity: number,
  itemDef: EquipmentItemDef,
  options?: EquipOptions,
): EquipResult {
  // State check (safe context only, unless forced)
  if (!options?.force && !isInSafeContext(world)) {
    return {
      ok: false,
      reasons: [{ type: 'invalidDef', message: 'Equipment changes only allowed in safe rooms' }],
    };
  }

  const result = canEquip(world, entity, itemDef);
  if (!result.allowed) {
    return { ok: false, reasons: result.reasons };
  }

  const state = getOrCreateState(world, entity);
  const instanceId = getNextInstanceId(world);
  const instance: EquipmentInstance = { instanceId, def: itemDef };

  for (const slotId of itemDef.slots) {
    state.equipped[slotId] = instanceId;
  }
  state.instances.set(instanceId, instance);

  recomputeEffectiveStats(world, entity);

  // Grant any timed/tracked status effects this item provides. Specs were
  // pre-validated in canEquip (validateItemDef), so these writes are infallible
  // and equip() stays atomic. Both sourceType and sourceId are normalized to this
  // equipment instance so unequip() clears them symmetrically (a def's granted spec
  // can never leak via a non-'equipment' sourceType), and duplicate-capable items
  // (e.g. two rings) track independently.
  for (const spec of itemDef.grantsStatusEffects ?? []) {
    applyStatusEffect(world, entity, {
      ...spec,
      sourceType: 'equipment',
      sourceId: equipmentSourceId(instanceId),
    });
  }

  // Weapon-typed equipment: activate the underlying WeaponDef when the player
  // equips it. Non-player entities silently skip this (equipment is entity-
  // agnostic in principle; only the player has an active weapon today).
  if (itemDef.weaponId !== undefined && hasComponent(world.ecs, entity, Player)) {
    const weaponDef = getWeaponDef(itemDef.weaponId);
    if (weaponDef !== undefined) {
      setActiveWeaponDef(world, weaponDef);
    }
  }

  return { ok: true, instanceId };
}

/** Unequip item from a slot. Frees all slots the item occupies. */
export function unequip(
  world: GameWorld,
  entity: number,
  slotId: EquipmentSlotId,
  options?: EquipOptions,
): UnequipResult {
  if (!options?.force && !isInSafeContext(world)) {
    return { ok: false, reason: 'Equipment changes only allowed in safe rooms' };
  }

  if (!isValidSlotId(slotId)) {
    return { ok: false, reason: `Unknown slot: ${slotId}` };
  }

  const state = getEquipmentMap(world).get(entity);
  if (!state) return { ok: false, reason: 'Entity has no equipment state' };

  const instId = state.equipped[slotId] ?? null;
  if (instId === null) return { ok: false, reason: 'Slot is empty' };

  const instance = state.instances.get(instId);
  if (!instance) return { ok: false, reason: 'Instance not found' };

  // Free all slots this instance occupies
  for (const sid of Object.keys(state.equipped)) {
    if (state.equipped[sid] === instId) {
      state.equipped[sid] = null;
    }
  }
  state.instances.delete(instId);

  // Remove only the status effects this specific equipment instance granted.
  clearStatusEffects(
    world,
    entity,
    (e) => e.sourceType === 'equipment' && e.sourceId === equipmentSourceId(instId),
  );

  // Weapon-typed equipment: clear the active weapon when the player unequips
  // it. Non-player entities silently skip this (equipment is entity-agnostic
  // in principle; only the player has an active weapon today).
  if (instance.def.weaponId !== undefined && hasComponent(world.ecs, entity, Player)) {
    clearActiveWeaponDef(world);
  }

  recomputeEffectiveStats(world, entity);
  return { ok: true, item: instance };
}

/** Result of `equipFromBag` — like `EquipResult` plus the ids swapped back to the bag. */
export type EquipFromBagResult =
  | { readonly ok: true; readonly instanceId: EquipmentInstanceId; readonly swappedOut: string[] }
  | { readonly ok: false; readonly reasons: EquipFailureReason[] };

/**
 * Equip an item that currently sits in the entity's inventory bag, performing
 * a Diablo-style swap: any item already occupying the target slot(s) is
 * unequipped back into the bag first, then the new item is moved from the bag
 * into the freed slot(s).
 *
 * Atomic: on any failure the bag and equipment are restored to their prior
 * state (removed item re-added, swapped-out items re-equipped). Honors the
 * same safe-context gate as `equip`/`unequip` unless `options.force` is set
 * (labs/tests). Returns the swapped-out item ids so callers can surface UI
 * feedback ("Unequipped X").
 */
export function equipFromBag(
  world: GameWorld,
  entity: number,
  itemId: string,
  options?: EquipOptions,
): EquipFromBagResult {
  if (!options?.force && !isInSafeContext(world)) {
    return {
      ok: false,
      reasons: [{ type: 'invalidDef', message: 'Equipment changes only allowed in safe rooms' }],
    };
  }

  const def = getEquipmentDefForItem(itemId);
  if (def === undefined) {
    return {
      ok: false,
      reasons: [{ type: 'invalidDef', message: `Item not equippable: ${itemId}` }],
    };
  }

  const bag = world.inventories.get(entity);
  if (!bag) {
    return { ok: false, reasons: [{ type: 'invalidDef', message: 'Entity has no inventory' }] };
  }
  if (!hasItem(bag, itemId, 1)) {
    return { ok: false, reasons: [{ type: 'invalidDef', message: `Item not in bag: ${itemId}` }] };
  }

  // Pre-mutation feasibility gate (this is what makes the swap ATOMIC): evaluate
  // the new item's validity + requirements against the POST-UNEQUIP stat basis —
  // the exact basis `equip` will see once the target slots are freed. If the swap
  // is infeasible we bail with the reasons here, BEFORE removing anything from the
  // bag or unequipping anything, so no item can be removed-then-lost in a failed
  // rollback. It also guarantees the forward `equip` below succeeds.
  const infeasible = swapEquipFailureReasons(world, entity, def);
  if (infeasible.length > 0) {
    return { ok: false, reasons: infeasible };
  }

  // Free every occupied target slot first (returning those items to the bag),
  // so `equip` below never trips the occupiedSlot guard. Internal equip/unequip
  // calls are forced because we already cleared the safe-context gate above.
  const internal = { force: true } as const;
  const state = getOrCreateState(world, entity);
  const swappedDefs: EquipmentItemDef[] = [];
  for (const slotId of def.slots) {
    if (!isValidSlotId(slotId) || state.equipped[slotId] === null) continue;
    const removed = unequip(world, entity, slotId, internal);
    if (removed.ok) {
      swappedDefs.push(removed.item.def);
      addItem(bag, removed.item.def.id, 1);
    }
  }

  removeItem(bag, itemId, 1);
  const result = equip(world, entity, def, internal);

  if (!result.ok) {
    // Roll back: restore the removed item and re-equip everything we swapped out.
    addItem(bag, itemId, 1);
    for (const swappedDef of swappedDefs) {
      removeItem(bag, swappedDef.id, 1);
      const restored = equip(world, entity, swappedDef, internal);
      // Defense-in-depth: the pre-mutation feasibility gate above makes a
      // forward-equip failure (and thus this rollback) unreachable today, but if
      // a future change reintroduces one, never silently delete a swapped item —
      // return it to the bag instead of dropping it on the floor.
      if (!restored.ok) addItem(bag, swappedDef.id, 1);
    }
    return { ok: false, reasons: result.reasons };
  }

  return { ok: true, instanceId: result.instanceId, swappedOut: swappedDefs.map((d) => d.id) };
}

/** Get effective stats for an entity. */
export function getEffectiveStats(world: GameWorld, entity: number): Record<StatId, number> {
  const result = {} as Record<StatId, number>;
  for (const statId of ALL_STAT_IDS) {
    result[statId] = world.stores.effectiveStats[statId][entity] ?? 0;
  }
  return result;
}

/**
 * Read-only preview of the net stat change from equipping a bag item, computed
 * as a Diablo-style swap: the delta accounts for the stats *gained* from the new
 * item AND the stats *lost* by unequipping whatever currently occupies its
 * slot(s). Performs no mutation — it evaluates the shared stat formula against a
 * hypothetical loadout and diffs it against the live one.
 */
export interface EquipDeltaPreview {
  /** Per-stat net change (hypothetical − current). Zero for unaffected stats. */
  readonly deltas: Record<StatId, number>;
  /** Item defs that would be unequipped (returned to the bag) to make room. */
  readonly swappedOut: readonly EquipmentItemDef[];
  /**
   * True when the item is valid and its requirements are met, so a swap would
   * be allowed (ignoring occupied slots, which the swap frees). The actual
   * equip is still subject to the safe-context gate at `equipFromBag` time.
   */
  readonly canEquip: boolean;
}

/**
 * Compute the {@link EquipDeltaPreview} for equipping `itemId` on `entity`.
 * Returns `null` when the item is not an equippable def at all.
 */
export function previewEquipDelta(
  world: GameWorld,
  entity: number,
  itemId: string,
): EquipDeltaPreview | null {
  const def = getEquipmentDefForItem(itemId);
  if (def === undefined) return null;

  const state = getEquipmentState(world, entity);

  // Base + core points are constant across the swap; read them once.
  const base = {} as Record<StatId, number>;
  for (const statId of ALL_STAT_IDS) {
    base[statId] = world.stores.baseStats[statId][entity] ?? 0;
  }
  const core = {} as Record<PrimaryStatId, number>;
  for (const p of PRIMARY_STATS) {
    core[p] = world.stores.coreStatPoints[p][entity] ?? 0;
  }

  const currentDefs = uniqueEquippedDefs(state);
  const currentStats = computeEffectiveStatsFromLoadout(base, core, currentDefs);

  // Identify the instances the new item would displace: any occupying one of
  // its target slots.
  const swappedInstanceIds = new Set<EquipmentInstanceId>();
  if (state) {
    for (const slotId of def.slots) {
      if (!isValidSlotId(slotId)) continue;
      const instId = state.equipped[slotId] ?? null;
      if (instId !== null) swappedInstanceIds.add(instId);
    }
  }
  const swappedOut: EquipmentItemDef[] = [];
  if (state) {
    for (const instId of swappedInstanceIds) {
      const inst = state.instances.get(instId);
      if (inst) swappedOut.push(inst.def);
    }
  }

  // Hypothetical loadout: keep everything not displaced, add the new item.
  const retainedSources: StatBonusSource[] = currentDefs
    .filter((d) => !swappedInstanceIds.has(d.instanceId))
    .map((d) => ({ statBonuses: d.statBonuses, weightLb: d.weightLb }));
  const hypotheticalStats = computeEffectiveStatsFromLoadout(base, core, [
    ...retainedSources,
    { statBonuses: def.statBonuses, weightLb: def.weightLb },
  ]);

  const deltas = {} as Record<StatId, number>;
  for (const statId of ALL_STAT_IDS) {
    deltas[statId] = hypotheticalStats[statId] - currentStats[statId];
  }

  // "Can equip via swap" must be evaluated against the POST-UNEQUIP basis (the
  // retained items, WITHOUT the new item's own bonuses) — the same basis the
  // real `equip` sees after the target slots are freed. Evaluating against live
  // stats here would wrongly pass an item whose requirement is only met by the
  // very item it would displace. Shared with equipFromBag's gate so the preview
  // verdict can never disagree with the actual equip result.
  const canEquipViaSwap = swapEquipFailureReasons(world, entity, def).length === 0;

  return { deltas, swappedOut, canEquip: canEquipViaSwap };
}

/** Get equipment state for an entity (read-only view). */
export function getEquipmentState(world: GameWorld, entity: number): EquipmentState | undefined {
  return getEquipmentMap(world).get(entity);
}

/** Clean up equipment state when entity is destroyed. */
export function clearEquipmentState(world: GameWorld, entity: number): void {
  getEquipmentMap(world).delete(entity);
  getEntityTagMap(world).delete(entity);
  if (hasComponent(world.ecs, entity, Equipment)) {
    removeComponent(world.ecs, entity, Equipment);
  }
  if (hasComponent(world.ecs, entity, BaseStats)) {
    removeComponent(world.ecs, entity, BaseStats);
  }
  if (hasComponent(world.ecs, entity, EffectiveStats)) {
    removeComponent(world.ecs, entity, EffectiveStats);
  }
}
