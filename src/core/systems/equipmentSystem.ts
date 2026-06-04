/**
 * Equipment System — pure functions for equip/unequip/canEquip.
 *
 * Uses WeakMap side-map pattern (same as weaponSystem.ts).
 * Equipment state is per-entity, stored outside ECS typed arrays.
 * Stat recomputation writes results into EffectiveStats typed-array store.
 */

import { addComponent, hasComponent, removeComponent, setComponent } from 'bitecs';
import { Equipment, BaseStats, EffectiveStats } from '../components.js';
import type { GameWorld } from '../world.js';
import { SLOT_REGISTRY, isValidSlotId } from '../../shared/equipment-slots.js';
import type { EquipmentSlotId } from '../../shared/equipment-slots.js';
import {
  ALL_STAT_IDS,
  isValidStatId,
  clampStat,
  DEFAULT_BASE_STATS,
  PRIMARY_STATS,
} from '../../shared/stats.js';
import type { StatId } from '../../shared/stats.js';
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
  const state = getEquipmentMap(world).get(entity);
  const stores = world.stores;

  // Start from base stats
  for (const statId of ALL_STAT_IDS) {
    const base = stores.baseStats[statId][entity] ?? 0;
    stores.effectiveStats[statId][entity] = base;
  }

  if (state) {
    // Iterate unique instance IDs (not slots) to avoid double-counting multi-slot items
    const seenInstances = new Set<EquipmentInstanceId>();
    for (const slotId of Object.keys(state.equipped)) {
      const instId = state.equipped[slotId] ?? null;
      if (instId === null || seenInstances.has(instId)) continue;
      seenInstances.add(instId);
      const inst = state.instances.get(instId);
      if (!inst) continue;
      for (const [stat, bonus] of Object.entries(inst.def.statBonuses)) {
        if (typeof bonus === 'number' && isValidStatId(stat)) {
          stores.effectiveStats[stat][entity] = (stores.effectiveStats[stat][entity] ?? 0) + bonus;
        }
      }
    }
  }

  // Apply clamps
  for (const statId of ALL_STAT_IDS) {
    stores.effectiveStats[statId][entity] = clampStat(
      statId,
      stores.effectiveStats[statId][entity] ?? 0,
    );
  }
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

  return reasons;
}

// --- Requirement evaluation ---

function evaluateRequirements(
  world: GameWorld,
  entity: number,
  itemDef: EquipmentItemDef,
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
        const current = stores.effectiveStats[req.stat]?.[entity] ?? 0;
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
}

/** Set entity tags (for hasTag/notTag requirements). */
export function setEntityTags(world: GameWorld, entity: number, tags: string[]): void {
  getEntityTagMap(world).set(entity, new Set(tags));
}

/** Get entity tags. */
export function getEntityTags(world: GameWorld, entity: number): ReadonlySet<string> {
  return getEntityTagMap(world).get(entity) ?? new Set();
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

/** Equip an item. Atomic — either fully succeeds or no state change. */
export function equip(
  world: GameWorld,
  entity: number,
  itemDef: EquipmentItemDef,
  options?: EquipOptions,
): EquipResult {
  // State check (safe room only, unless forced)
  if (!options?.force && world.state !== 'safe_room') {
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
  return { ok: true, instanceId };
}

/** Unequip item from a slot. Frees all slots the item occupies. */
export function unequip(
  world: GameWorld,
  entity: number,
  slotId: EquipmentSlotId,
  options?: EquipOptions,
): UnequipResult {
  if (!options?.force && world.state !== 'safe_room') {
    return { ok: false, reason: 'Equipment changes only allowed in safe rooms' };
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

  recomputeEffectiveStats(world, entity);
  return { ok: true, item: instance };
}

/** Get effective stats for an entity. */
export function getEffectiveStats(world: GameWorld, entity: number): Record<StatId, number> {
  const result = {} as Record<StatId, number>;
  for (const statId of ALL_STAT_IDS) {
    result[statId] = world.stores.effectiveStats[statId][entity] ?? 0;
  }
  return result;
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
