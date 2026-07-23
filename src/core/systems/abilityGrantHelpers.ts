/**
 * Core-layer ability grant helpers for generated equipment.
 *
 * These functions mirror the grant/revoke logic in
 * `game/systems/abilitySystem.ts` but operate without the ability-definition
 * registry (a `game/` concern), so they can be called from `core/` code such
 * as `equipmentSystem.ts`.
 *
 * The callers are responsible for ensuring `abilityId` maps to the correct
 * slot kind (active vs. passive); no def-level validation is performed here.
 */

import {
  ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
  ACTIVE_ABILITY_SLOT_LIMIT,
  equipmentAbilityGrantSourceId,
  type AbilityState,
} from '../../shared/abilities.js';
import type { GameWorld } from '../world.js';
import type { GeneratedEquipmentInstanceId } from '../../shared/generated-equipment-types.js';

function getOrCreateAbilityStateCore(world: GameWorld, holderEid: number): AbilityState {
  const existing = world.abilityStatesByEntity.get(holderEid);
  if (existing !== undefined) return existing;
  const created: AbilityState = {
    learnedSpellIds: [],
    equippedActiveAbilityIds: [],
    ownedActiveAbilityIds: [],
    passiveAbilityIds: [],
    cooldownByAbilityId: new Map(),
    cooldownFramesByAbilityId: new Map(),
    appliedPassiveAbilityIds: new Set(),
    grantOwnership: {
      schemaVersion: ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
      activeSourcesByAbilityId: new Map(),
      passiveSourcesByAbilityId: new Map(),
    },
  };
  world.abilityStatesByEntity.set(holderEid, created);
  return created;
}

/**
 * Grant an active ability from a generated-equipment instance.
 * Idempotent: repeated calls with the same `(instanceId, effectOrdinal)` are no-ops.
 */
export function grantGeneratedEquipmentActiveAbilityCore(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  instanceId: GeneratedEquipmentInstanceId,
  effectOrdinal: number,
): void {
  const state = getOrCreateAbilityStateCore(world, holderEid);
  const ownership = (state.grantOwnership ??= {
    schemaVersion: ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
    activeSourcesByAbilityId: new Map(),
    passiveSourcesByAbilityId: new Map(),
  });
  const sourceId = equipmentAbilityGrantSourceId(instanceId, effectOrdinal);
  let sources = ownership.activeSourcesByAbilityId.get(abilityId);
  if (sources === undefined) {
    sources = new Set();
    ownership.activeSourcesByAbilityId.set(abilityId, sources);
  } else if (sources.has(sourceId)) {
    return;
  }
  sources.add(sourceId);
  if (!state.equippedActiveAbilityIds.includes(abilityId)) {
    if (state.equippedActiveAbilityIds.length < ACTIVE_ABILITY_SLOT_LIMIT) {
      state.equippedActiveAbilityIds.push(abilityId);
    }
  }
  if (!(state.ownedActiveAbilityIds ?? []).includes(abilityId)) {
    (state.ownedActiveAbilityIds ??= []).push(abilityId);
  }
}

/**
 * Grant a passive ability from a generated-equipment instance.
 * Idempotent: repeated calls with the same `(instanceId, effectOrdinal)` are no-ops.
 */
export function grantGeneratedEquipmentPassiveAbilityCore(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  instanceId: GeneratedEquipmentInstanceId,
  effectOrdinal: number,
): void {
  const state = getOrCreateAbilityStateCore(world, holderEid);
  const ownership = (state.grantOwnership ??= {
    schemaVersion: ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
    activeSourcesByAbilityId: new Map(),
    passiveSourcesByAbilityId: new Map(),
  });
  const sourceId = equipmentAbilityGrantSourceId(instanceId, effectOrdinal);
  let sources = ownership.passiveSourcesByAbilityId.get(abilityId);
  if (sources === undefined) {
    sources = new Set();
    ownership.passiveSourcesByAbilityId.set(abilityId, sources);
  } else if (sources.has(sourceId)) {
    return;
  }
  sources.add(sourceId);
  if (!state.passiveAbilityIds.includes(abilityId)) {
    state.passiveAbilityIds.push(abilityId);
  }
}

/**
 * Revoke all ability grants (active and passive) from a specific generated equipment instance.
 * Idempotent: calling with an instanceId that has no matching grants is a no-op.
 */
export function revokeEquipmentAbilityGrantsCore(
  world: GameWorld,
  holderEid: number,
  instanceId: GeneratedEquipmentInstanceId,
): void {
  const state = world.abilityStatesByEntity.get(holderEid);
  if (state === undefined) return;
  const ownership = state.grantOwnership;
  if (ownership === undefined) return;

  const instancePrefix = `equipment:${instanceId}:`;
  const isMatchingSource = (s: string): boolean => s.startsWith(instancePrefix);

  for (const abilityId of [...ownership.activeSourcesByAbilityId.keys()]) {
    const sources = ownership.activeSourcesByAbilityId.get(abilityId);
    if (sources === undefined) continue;
    const sizeBefore = sources.size;
    for (const s of [...sources]) {
      if (isMatchingSource(s)) sources.delete(s);
    }
    if (sources.size === sizeBefore) continue;
    if (sources.size === 0) {
      ownership.activeSourcesByAbilityId.delete(abilityId);
      const idx = state.equippedActiveAbilityIds.indexOf(abilityId);
      if (idx !== -1) {
        state.equippedActiveAbilityIds.splice(idx, 1);
      }
      const ownedIdx = (state.ownedActiveAbilityIds ?? []).indexOf(abilityId);
      if (ownedIdx !== -1) {
        state.ownedActiveAbilityIds!.splice(ownedIdx, 1);
      }
    }
  }

  for (const abilityId of [...ownership.passiveSourcesByAbilityId.keys()]) {
    const sources = ownership.passiveSourcesByAbilityId.get(abilityId);
    if (sources === undefined) continue;
    const sizeBefore = sources.size;
    for (const s of [...sources]) {
      if (isMatchingSource(s)) sources.delete(s);
    }
    if (sources.size === sizeBefore) continue;
    if (sources.size === 0) {
      ownership.passiveSourcesByAbilityId.delete(abilityId);
      const idx = state.passiveAbilityIds.indexOf(abilityId);
      if (idx !== -1) {
        state.passiveAbilityIds.splice(idx, 1);
      }
    }
  }
}
