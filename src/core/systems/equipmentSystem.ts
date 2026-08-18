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
import type { WeaponDef } from '../../shared/weaponDefs.js';
import {
  setActiveWeaponDef,
  clearActiveWeaponDef,
  getActiveWeaponSnapshot,
} from '../active-weapon.js';
import { getEquipmentDefForItem } from '../../shared/equipmentDefs.js';
import { getItemById } from '../../shared/items.js';
import {
  addGeneratedEquipmentReference,
  addItem,
  canAcceptGeneratedEquipment,
  hasGeneratedEquipmentReference,
  hasItem,
  listGeneratedEquipmentReferences,
  removeGeneratedEquipmentReference,
  removeItem,
  type GeneratedEquipmentInventoryEntry,
  type InventoryBagEntry,
  type StackableStaticInventoryEntry,
} from '../../shared/inventory.js';
import type {
  GeneratedEquipmentInstanceKey,
  GeneratedEquipmentInstanceV1,
} from '../../shared/generated-equipment-types.js';
import {
  EQUIPMENT_REWARD_TIER_RARITIES,
  type EquipmentRewardTier,
} from '../../shared/generated-equipment-types.js';
import { getGeneratedEquipmentInstance } from '../generated-equipment-registry.js';
import {
  coreGrantGeneratedEquipmentActiveAbility,
  coreGrantGeneratedEquipmentPassiveAbility,
  revokeEquipmentAbilityGrantsCore,
} from '../ability-grants.js';
import { getCustomRequirements, getEntityTagMap } from '../equipment-system-state.js';

// --- Side-map storage ---

const equipmentStates = new WeakMap<GameWorld, Map<number, EquipmentState>>();
const instanceCounters = new WeakMap<GameWorld, { next: number }>();
const generatedDefViews = new WeakMap<GeneratedEquipmentInstanceV1, EquipmentItemDef>();

function getEquipmentMap(world: GameWorld): Map<number, EquipmentState> {
  let map = equipmentStates.get(world);
  if (!map) {
    map = new Map();
    equipmentStates.set(world, map);
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

function generatedInventoryEntry(
  instanceKey: GeneratedEquipmentInstanceKey,
): GeneratedEquipmentInventoryEntry {
  return { kind: 'generated-instance', instanceKey };
}

function staticInventoryEntry(def: EquipmentItemDef): StackableStaticInventoryEntry {
  return { kind: 'stackable-static-item', itemId: def.id, quantity: 1 };
}

function generatedEquipmentDef(instance: GeneratedEquipmentInstanceV1): EquipmentItemDef {
  const cached = generatedDefViews.get(instance);
  if (cached) return cached;
  const def: EquipmentItemDef = Object.freeze({
    id: instance.instanceId,
    name: instance.frozen.displayName,
    slots: instance.frozen.slots,
    statBonuses: instance.frozen.statBonuses,
    rarity: instance.rarity,
    tags: instance.frozen.tags,
    weightLb: instance.frozen.weightLb,
  });
  generatedDefViews.set(instance, def);
  return def;
}

/** Resolve either a legacy numeric instance or an exact B1 registry reference. */
export function resolveEquipmentInstance(
  world: GameWorld,
  state: EquipmentState,
  instanceId: EquipmentInstanceId,
): EquipmentInstance | undefined {
  if (typeof instanceId === 'number') {
    return state.instances.get(instanceId);
  }
  const generated = getGeneratedEquipmentInstance(world, instanceId);
  if (!generated) return undefined;
  return { instanceId, def: generatedEquipmentDef(generated) };
}

export interface GeneratedPhysicalOwner {
  readonly container: 'bag' | 'equipped' | 'reward-bundle';
  readonly entity?: number;
  readonly bundleId?: string;
}

export function findGeneratedPhysicalOwners(
  world: GameWorld,
  instanceKey: GeneratedEquipmentInstanceKey,
): GeneratedPhysicalOwner[] {
  const owners: GeneratedPhysicalOwner[] = [];
  for (const [entity, bag] of world.inventories) {
    for (const entry of listGeneratedEquipmentReferences(bag)) {
      if (entry.instanceKey !== instanceKey) continue;
      owners.push({ container: 'bag', entity });
    }
  }
  for (const [entity, state] of equipmentStates.get(world) ?? []) {
    if (Object.values(state.equipped).some((instanceId) => instanceId === instanceKey)) {
      owners.push({ container: 'equipped', entity });
    }
  }
  for (const [bundleId, bundle] of world.generatedEquipmentRewardBundles) {
    for (const bundleKey of bundle.instanceKeys) {
      if (bundleKey === instanceKey) {
        owners.push({ container: 'reward-bundle', bundleId });
      }
    }
  }
  return owners;
}

function ownershipConflict(
  instanceKey: GeneratedEquipmentInstanceKey,
  message: string,
): EquipFailureReason {
  return { type: 'generatedOwnershipConflict', instanceKey, message };
}

function generatedWeaponDef(instance: GeneratedEquipmentInstanceV1): WeaponDef | undefined {
  return instance.frozen.activeWeaponSnapshot ?? undefined;
}

function activateGeneratedEquipment(
  world: GameWorld,
  entity: number,
  instance: GeneratedEquipmentInstanceV1,
): void {
  for (const effect of instance.resolvedEffects) {
    if (!('kind' in effect)) continue;
    if (effect.kind === 'abilityGrant') {
      coreGrantGeneratedEquipmentActiveAbility(
        world,
        entity,
        effect.grantId,
        instance.instanceId,
        effect.effectOrdinal,
      );
    } else if (effect.kind === 'passiveGrant') {
      coreGrantGeneratedEquipmentPassiveAbility(
        world,
        entity,
        effect.grantId,
        instance.instanceId,
        effect.effectOrdinal,
      );
    }
  }

  const weaponDef = generatedWeaponDef(instance);
  if (weaponDef && hasComponent(world.ecs, entity, Player)) {
    setActiveWeaponDef(world, weaponDef);
  }
}

function deactivateGeneratedEquipment(
  world: GameWorld,
  entity: number,
  instanceKey: GeneratedEquipmentInstanceKey,
): void {
  const generated = getGeneratedEquipmentInstance(world, instanceKey);
  if (!generated) throw new Error(`Generated equipment instance not found: ${instanceKey}`);
  revokeEquipmentAbilityGrantsCore(world, entity, instanceKey);

  if (
    generated.frozen.activeWeaponSnapshot !== null &&
    hasComponent(world.ecs, entity, Player) &&
    getActiveWeaponSnapshot(world)?.generatedEquipmentInstanceId === instanceKey
  ) {
    clearActiveWeaponDef(world);
  }
}

interface PreparedDisplacedInstance {
  readonly instanceId: EquipmentInstanceId;
  readonly instance: EquipmentInstance;
}

type PrepareDisplacedResult =
  | { readonly ok: true; readonly displaced: readonly PreparedDisplacedInstance[] }
  | { readonly ok: false; readonly reason: EquipFailureReason };

function prepareDisplacedInstances(
  world: GameWorld,
  entity: number,
  bag: NonNullable<ReturnType<GameWorld['inventories']['get']>>,
  state: EquipmentState,
  displacedIds: ReadonlySet<EquipmentInstanceId>,
): PrepareDisplacedResult {
  const displaced: PreparedDisplacedInstance[] = [];
  for (const instanceId of displacedIds) {
    const instance = resolveEquipmentInstance(world, state, instanceId);
    if (!instance) {
      return {
        ok: false,
        reason: { type: 'invalidDef', message: `Equipped instance not found: ${instanceId}` },
      };
    }
    if (typeof instanceId === 'number') {
      const item = getItemById(instance.def.id);
      if (!item || item.maxStack <= 0) {
        return {
          ok: false,
          reason: {
            type: 'invalidDef',
            message: `Cannot return invalid static item to bag: ${instance.def.id}`,
          },
        };
      }
    } else {
      const owners = findGeneratedPhysicalOwners(world, instanceId);
      if (
        owners.length !== 1 ||
        owners[0]?.container !== 'equipped' ||
        owners[0].entity !== entity ||
        hasGeneratedEquipmentReference(bag, instanceId)
      ) {
        return {
          ok: false,
          reason: ownershipConflict(
            instanceId,
            'Displaced generated equipment ownership is invalid',
          ),
        };
      }
    }
    displaced.push({ instanceId, instance });
  }
  return { ok: true, displaced };
}

/**
 * Commit prevalidated displaced instances to the bag without invoking another
 * fallible equip/unequip operation. Callers recompute stats once after the full
 * transfer is complete.
 */
function movePreparedDisplacedToBag(
  world: GameWorld,
  entity: number,
  bag: NonNullable<ReturnType<GameWorld['inventories']['get']>>,
  state: EquipmentState,
  displaced: readonly PreparedDisplacedInstance[],
): InventoryBagEntry[] {
  const entries: InventoryBagEntry[] = [];
  for (const { instanceId, instance } of displaced) {
    for (const slotId of Object.keys(state.equipped)) {
      if (state.equipped[slotId] === instanceId) {
        state.equipped[slotId] = null;
      }
    }
    if (typeof instanceId === 'number') {
      state.instances.delete(instanceId);
      addItem(bag, instance.def.id, 1);
      entries.push(staticInventoryEntry(instance.def));
    } else {
      deactivateGeneratedEquipment(world, entity, instanceId);
      entries.push(addGeneratedEquipmentReference(bag, instanceId));
    }
    clearStatusEffects(
      world,
      entity,
      (effect) =>
        effect.sourceType === 'equipment' && effect.sourceId === equipmentSourceId(instanceId),
    );
    if (
      typeof instanceId === 'number' &&
      instance.def.weaponId !== undefined &&
      hasComponent(world.ecs, entity, Player)
    ) {
      clearActiveWeaponDef(world);
    }
  }
  return entries;
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
  const postUnequipSources: StatBonusSource[] = uniqueEquippedDefs(world, state)
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

/** Check if an item can be equipped — returns allowed + reasons. */
function canEquip(world: GameWorld, entity: number, itemDef: EquipmentItemDef): CanEquipResult {
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

/**
 * Commit phase shared by `equip` and `equipFromBag` for static items.
 * Allocates an instance id, writes slots and instance map, recomputes stats,
 * grants status effects, and activates the weapon — in the canonical order
 * established by `equip`.
 *
 * Callers are responsible for all pre-validation and bag mutations before
 * invoking this helper.
 */
function commitStaticEquipInstance(
  world: GameWorld,
  entity: number,
  state: EquipmentState,
  def: EquipmentItemDef,
): EquipmentInstanceId {
  const instanceId = getNextInstanceId(world);
  const instance: EquipmentInstance = { instanceId, def };

  for (const slotId of def.slots) {
    state.equipped[slotId] = instanceId;
  }
  state.instances.set(instanceId, instance);

  recomputeEffectiveStats(world, entity);

  // Grant any timed/tracked status effects this item provides. Specs were
  // pre-validated in canEquip (validateItemDef), so these writes are infallible
  // and the caller stays atomic. Both sourceType and sourceId are normalized to
  // this equipment instance so unequip() clears them symmetrically.
  for (const spec of def.grantsStatusEffects ?? []) {
    applyStatusEffect(world, entity, {
      ...spec,
      sourceType: 'equipment',
      sourceId: equipmentSourceId(instanceId),
    });
  }

  // Weapon-typed equipment: activate the underlying WeaponDef when the player
  // equips it. Non-player entities silently skip this.
  if (def.weaponId !== undefined && hasComponent(world.ecs, entity, Player)) {
    const weaponDef = getWeaponDef(def.weaponId);
    if (weaponDef !== undefined) {
      setActiveWeaponDef(world, weaponDef);
    }
  }

  return instanceId;
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
  const instanceId = commitStaticEquipInstance(world, entity, state, itemDef);

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

  const instance = resolveEquipmentInstance(world, state, instId);
  if (!instance) return { ok: false, reason: 'Instance not found' };

  let generatedBagEntry: GeneratedEquipmentInventoryEntry | undefined;
  if (typeof instId !== 'number') {
    const bag = world.inventories.get(entity);
    if (!bag) return { ok: false, reason: 'Entity has no inventory' };
    const owners = findGeneratedPhysicalOwners(world, instId);
    if (owners.length !== 1 || owners[0]?.container !== 'equipped' || owners[0].entity !== entity) {
      return { ok: false, reason: `Generated equipment ownership conflict: ${instId}` };
    }
    if (hasGeneratedEquipmentReference(bag, instId)) {
      return { ok: false, reason: `Generated equipment already exists in bag: ${instId}` };
    }
    generatedBagEntry = generatedInventoryEntry(instId);
  }

  // Free all slots this instance occupies
  for (const sid of Object.keys(state.equipped)) {
    if (state.equipped[sid] === instId) {
      state.equipped[sid] = null;
    }
  }
  if (typeof instId === 'number') {
    state.instances.delete(instId);
  } else {
    deactivateGeneratedEquipment(world, entity, instId);
  }

  // Remove only the status effects this specific equipment instance granted.
  clearStatusEffects(
    world,
    entity,
    (e) => e.sourceType === 'equipment' && e.sourceId === equipmentSourceId(instId),
  );

  // Weapon-typed equipment: clear the active weapon when the player unequips
  // it. Non-player entities silently skip this (equipment is entity-agnostic
  // in principle; only the player has an active weapon today).
  if (
    typeof instId === 'number' &&
    instance.def.weaponId !== undefined &&
    hasComponent(world.ecs, entity, Player)
  ) {
    clearActiveWeaponDef(world);
  }

  if (generatedBagEntry) {
    addGeneratedEquipmentReference(world.inventories.get(entity)!, generatedBagEntry.instanceKey);
  }
  recomputeEffectiveStats(world, entity);
  return {
    ok: true,
    item: instance,
    entry: generatedBagEntry ?? staticInventoryEntry(instance.def),
    bagUpdated: generatedBagEntry !== undefined,
  };
}

/** Result of `equipFromBag` — like `EquipResult` plus the ids swapped back to the bag. */
export type EquipFromBagResult =
  | {
      readonly ok: true;
      readonly instanceId: EquipmentInstanceId;
      readonly swappedOut: string[];
      readonly swappedOutEntries: readonly InventoryBagEntry[];
    }
  | { readonly ok: false; readonly reasons: EquipFailureReason[] };

export type AddGeneratedEquipmentToBagResult =
  | { readonly ok: true; readonly entry: GeneratedEquipmentInventoryEntry }
  | { readonly ok: false; readonly reason: EquipFailureReason };

/**
 * Establish initial bag ownership for one registry-owned generated instance.
 * Later reward/merchant/drop slices must use this seam instead of mutating bags.
 */
export function addGeneratedEquipmentToBag(
  world: GameWorld,
  entity: number,
  instanceKey: GeneratedEquipmentInstanceKey,
): AddGeneratedEquipmentToBagResult {
  if (!getGeneratedEquipmentInstance(world, instanceKey)) {
    return {
      ok: false,
      reason: {
        type: 'generatedInstanceNotFound',
        instanceKey,
        message: `Generated equipment instance not found: ${instanceKey}`,
      },
    };
  }
  const bag = world.inventories.get(entity);
  if (!bag) {
    return { ok: false, reason: { type: 'invalidDef', message: 'Entity has no inventory' } };
  }
  const owners = findGeneratedPhysicalOwners(world, instanceKey);
  if (owners.length > 0) {
    return {
      ok: false,
      reason: ownershipConflict(
        instanceKey,
        `Generated equipment already has an owner: ${owners
          .map((owner) => `${owner.container}:${owner.entity ?? owner.bundleId}`)
          .join(', ')}`,
      ),
    };
  }
  return { ok: true, entry: addGeneratedEquipmentReference(bag, instanceKey) };
}

export interface ClaimedRewardBundleEntry {
  readonly instanceKey: GeneratedEquipmentInstanceKey;
  readonly entry: GeneratedEquipmentInventoryEntry;
}

export type ClaimGeneratedEquipmentRewardBundleResult =
  | { readonly ok: true; readonly granted: readonly ClaimedRewardBundleEntry[] }
  | { readonly ok: false; readonly reason: EquipFailureReason };

/**
 * Atomically transfer ownership of a resolved reward bundle's instances from the
 * bundle to an entity's bag.
 *
 * Reward bundles ARE registry owners (`findGeneratedPhysicalOwners` reports
 * `container:'reward-bundle'`), so this cannot go through
 * {@link addGeneratedEquipmentToBag} — that rejects any already-owned instance.
 * Every destination is validated FIRST (bundle exists, bag exists, capacity for
 * the whole bundle, each instance present in the registry, no intra-bundle
 * duplicate, and the only physical owner of each instance is exactly this
 * bundle). `expectedTier` must match the bundle's own tier — a defense-in-depth
 * cross-check against the achievement's CURRENT declared tier, mirroring the
 * same check the carryover restore validator performs. Only after all checks
 * pass does it perform a no-throw commit: delete the bundle from the map, then
 * add each bag reference. On any failure the world is untouched (fail-closed).
 * Never invokes the generator, so it is safe on claim/load/presentation paths.
 */
export function claimGeneratedEquipmentRewardBundle(
  world: GameWorld,
  entity: number,
  achievementId: string,
  expectedTier: EquipmentRewardTier,
): ClaimGeneratedEquipmentRewardBundleResult {
  const bundle = world.generatedEquipmentRewardBundles.get(achievementId);
  if (!bundle) {
    return {
      ok: false,
      reason: { type: 'invalidDef', message: `No reward bundle for achievement: ${achievementId}` },
    };
  }
  // Tier cross-check (fail-closed, defense in depth): the bundle's own tier
  // must match the achievement definition's CURRENT declared tier at claim
  // time — the same check the carryover restore validator already performs —
  // so a bundle resolved under a stale/edited catalog tier can never be
  // claimed under a different tier's contract.
  if (bundle.tier !== expectedTier) {
    return {
      ok: false,
      reason: {
        type: 'invalidDef',
        message: `Reward bundle tier ${bundle.tier} does not match expected tier ${expectedTier}`,
      },
    };
  }
  // Shape guard (fail-closed): a resolved tiered bundle ALWAYS holds exactly
  // ONE instance whose rarity is a member of that tier's allowed pool (see
  // `EQUIPMENT_REWARD_TIER_RARITIES`). Reject a malformed bundle (wrong count)
  // BEFORE any mutation so a stale/injected empty or partial bundle can never
  // be "claimed" as a success that consumes the reward for nothing. Per-instance
  // rarity is verified in the validation loop below.
  if (bundle.instanceKeys.length !== 1) {
    return {
      ok: false,
      reason: {
        type: 'invalidDef',
        message: `Reward bundle has ${bundle.instanceKeys.length} instances, expected 1`,
      },
    };
  }
  const bag = world.inventories.get(entity);
  if (!bag) {
    return { ok: false, reason: { type: 'invalidDef', message: 'Entity has no inventory' } };
  }
  if (!canAcceptGeneratedEquipment(bag, bundle.instanceKeys.length)) {
    return {
      ok: false,
      reason: {
        type: 'invalidDef',
        message: `Bag cannot accept ${bundle.instanceKeys.length} generated equipment items`,
      },
    };
  }
  const seen = new Set<GeneratedEquipmentInstanceKey>();
  for (let index = 0; index < bundle.instanceKeys.length; index += 1) {
    const instanceKey = bundle.instanceKeys[index]!;
    if (seen.has(instanceKey)) {
      return {
        ok: false,
        reason: ownershipConflict(
          instanceKey,
          `Duplicate instance in reward bundle: ${instanceKey}`,
        ),
      };
    }
    seen.add(instanceKey);
    const instance = getGeneratedEquipmentInstance(world, instanceKey);
    if (!instance) {
      return {
        ok: false,
        reason: {
          type: 'generatedInstanceNotFound',
          instanceKey,
          message: `Generated equipment instance not found: ${instanceKey}`,
        },
      };
    }
    const expectedRarities = EQUIPMENT_REWARD_TIER_RARITIES[bundle.tier];
    if (!expectedRarities.includes(instance.rarity)) {
      return {
        ok: false,
        reason: {
          type: 'invalidDef',
          message: `Reward bundle instance ${index} has rarity ${instance.rarity}, expected one of [${expectedRarities.join(', ')}] for tier ${bundle.tier}`,
        },
      };
    }
    if (hasGeneratedEquipmentReference(bag, instanceKey)) {
      return {
        ok: false,
        reason: ownershipConflict(
          instanceKey,
          `Generated equipment already in bag: ${instanceKey}`,
        ),
      };
    }
    const foreignOwners = findGeneratedPhysicalOwners(world, instanceKey).filter(
      (owner) => !(owner.container === 'reward-bundle' && owner.bundleId === achievementId),
    );
    if (foreignOwners.length > 0) {
      return {
        ok: false,
        reason: ownershipConflict(
          instanceKey,
          `Reward bundle instance has a foreign owner: ${foreignOwners
            .map((owner) => `${owner.container}:${owner.entity ?? owner.bundleId}`)
            .join(', ')}`,
        ),
      };
    }
  }
  world.generatedEquipmentRewardBundles.delete(achievementId);
  const granted: ClaimedRewardBundleEntry[] = [];
  for (const instanceKey of bundle.instanceKeys) {
    granted.push({ instanceKey, entry: addGeneratedEquipmentReference(bag, instanceKey) });
  }
  return { ok: true, granted };
}

function equipGeneratedFromBag(
  world: GameWorld,
  entity: number,
  entry: GeneratedEquipmentInventoryEntry,
  options?: EquipOptions,
): EquipFromBagResult {
  const instanceKey = entry.instanceKey;
  if (world.floorScenario !== null && !world.featureUnlocks.equipment) {
    return {
      ok: false,
      reasons: [{ type: 'invalidDef', message: 'Generated equipment is not unlocked yet' }],
    };
  }
  if (!options?.force && !isInSafeContext(world)) {
    return {
      ok: false,
      reasons: [{ type: 'invalidDef', message: 'Equipment changes only allowed in safe rooms' }],
    };
  }

  const bag = world.inventories.get(entity);
  if (!bag) {
    return { ok: false, reasons: [{ type: 'invalidDef', message: 'Entity has no inventory' }] };
  }
  const generated = getGeneratedEquipmentInstance(world, instanceKey);
  if (!generated) {
    return {
      ok: false,
      reasons: [
        {
          type: 'generatedInstanceNotFound',
          instanceKey,
          message: `Generated equipment instance not found: ${instanceKey}`,
        },
      ],
    };
  }
  if (!hasGeneratedEquipmentReference(bag, instanceKey)) {
    return {
      ok: false,
      reasons: [
        ownershipConflict(instanceKey, `Generated equipment is not in entity ${entity}'s bag`),
      ],
    };
  }
  const owners = findGeneratedPhysicalOwners(world, instanceKey);
  if (owners.length !== 1 || owners[0]?.container !== 'bag' || owners[0].entity !== entity) {
    return {
      ok: false,
      reasons: [ownershipConflict(instanceKey, 'Generated equipment does not have one bag owner')],
    };
  }
  const def = generatedEquipmentDef(generated);
  const infeasible = swapEquipFailureReasons(world, entity, def);
  if (infeasible.length > 0) return { ok: false, reasons: infeasible };

  const state = getOrCreateState(world, entity);
  const displacedIds = new Set<EquipmentInstanceId>();
  for (const slotId of def.slots) {
    const displacedId = state.equipped[slotId] ?? null;
    if (displacedId !== null) displacedIds.add(displacedId);
  }

  const prepared = prepareDisplacedInstances(world, entity, bag, state, displacedIds);
  if (!prepared.ok) return { ok: false, reasons: [prepared.reason] };

  const swappedOutEntries = movePreparedDisplacedToBag(
    world,
    entity,
    bag,
    state,
    prepared.displaced,
  );
  removeGeneratedEquipmentReference(bag, instanceKey);
  for (const slotId of def.slots) {
    state.equipped[slotId] = instanceKey;
  }
  activateGeneratedEquipment(world, entity, generated);
  recomputeEffectiveStats(world, entity);

  return {
    ok: true,
    instanceId: instanceKey,
    swappedOut: swappedOutEntries.map((swapped) =>
      swapped.kind === 'generated-instance' ? swapped.instanceKey : swapped.itemId,
    ),
    swappedOutEntries,
  };
}

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
  entry: GeneratedEquipmentInventoryEntry,
  options?: EquipOptions,
): EquipFromBagResult;
export function equipFromBag(
  world: GameWorld,
  entity: number,
  itemId: string,
  options?: EquipOptions,
): EquipFromBagResult;
export function equipFromBag(
  world: GameWorld,
  entity: number,
  item: string | GeneratedEquipmentInventoryEntry,
  options?: EquipOptions,
): EquipFromBagResult;
export function equipFromBag(
  world: GameWorld,
  entity: number,
  item: string | GeneratedEquipmentInventoryEntry,
  options?: EquipOptions,
): EquipFromBagResult {
  if (typeof item !== 'string') {
    return equipGeneratedFromBag(world, entity, item, options);
  }
  const itemId = item;
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

  const state = getOrCreateState(world, entity);
  const displacedIds = new Set<EquipmentInstanceId>();
  for (const slotId of def.slots) {
    const displacedId = state.equipped[slotId] ?? null;
    if (displacedId !== null) displacedIds.add(displacedId);
  }
  const prepared = prepareDisplacedInstances(world, entity, bag, state, displacedIds);
  if (!prepared.ok) return { ok: false, reasons: [prepared.reason] };

  const swappedOutEntries = movePreparedDisplacedToBag(
    world,
    entity,
    bag,
    state,
    prepared.displaced,
  );
  removeItem(bag, itemId, 1);
  const instanceId = commitStaticEquipInstance(world, entity, state, def);

  return {
    ok: true,
    instanceId,
    swappedOut: swappedOutEntries.map((swapped) =>
      swapped.kind === 'generated-instance' ? swapped.instanceKey : swapped.itemId,
    ),
    swappedOutEntries,
  };
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

  const currentDefs = uniqueEquippedDefs(world, state);
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
      const inst = resolveEquipmentInstance(world, state, instId);
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
