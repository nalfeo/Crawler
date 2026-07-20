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
  ACTIVE_ABILITY_SLOT_LIMIT,
  type AbilityGrantSource,
  type AbilityState,
} from '../../shared/abilities.js';
import type { GameWorld } from '../world.js';
import type { GeneratedEquipmentInstanceId } from '../../shared/generated-equipment-types.js';
import type { EquipmentInstanceId } from '../../shared/equipment-types.js';

function getOrCreateAbilityStateCore(world: GameWorld, holderEid: number): AbilityState {
  const existing = world.abilityStatesByEntity.get(holderEid);
  if (existing !== undefined) return existing;
  const created: AbilityState = {
    learnedSpellIds: [],
    equippedActiveAbilityIds: [],
    passiveAbilityIds: [],
    cooldownByAbilityId: new Map(),
    cooldownFramesByAbilityId: new Map(),
    appliedPassiveAbilityIds: new Set(),
    activeAbilityGrantSources: new Map(),
    passiveAbilityGrantSources: new Map(),
  };
  world.abilityStatesByEntity.set(holderEid, created);
  return created;
}

function addActiveGrantSource(
  state: AbilityState,
  abilityId: string,
  source: AbilityGrantSource,
): void {
  const sources = state.activeAbilityGrantSources.get(abilityId);
  if (sources === undefined) {
    state.activeAbilityGrantSources.set(abilityId, [source]);
  } else {
    sources.push(source);
  }
}

function addPassiveGrantSource(
  state: AbilityState,
  abilityId: string,
  source: AbilityGrantSource,
): void {
  const sources = state.passiveAbilityGrantSources.get(abilityId);
  if (sources === undefined) {
    state.passiveAbilityGrantSources.set(abilityId, [source]);
  } else {
    sources.push(source);
  }
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
  const source: AbilityGrantSource = { kind: 'generated-equipment', instanceId, effectOrdinal };
  const existing = state.activeAbilityGrantSources.get(abilityId);
  if (
    existing?.some(
      (s) =>
        s.kind === 'generated-equipment' &&
        s.instanceId === instanceId &&
        s.effectOrdinal === effectOrdinal,
    )
  ) {
    return;
  }
  if (state.equippedActiveAbilityIds.includes(abilityId)) {
    addActiveGrantSource(state, abilityId, source);
    return;
  }
  if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
    addActiveGrantSource(state, abilityId, source);
    return;
  }
  state.equippedActiveAbilityIds.push(abilityId);
  addActiveGrantSource(state, abilityId, source);
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
  const source: AbilityGrantSource = { kind: 'generated-equipment', instanceId, effectOrdinal };
  const existing = state.passiveAbilityGrantSources.get(abilityId);
  if (
    existing?.some(
      (s) =>
        s.kind === 'generated-equipment' &&
        s.instanceId === instanceId &&
        s.effectOrdinal === effectOrdinal,
    )
  ) {
    return;
  }
  if (!state.passiveAbilityIds.includes(abilityId)) {
    state.passiveAbilityIds.push(abilityId);
  }
  addPassiveGrantSource(state, abilityId, source);
}

/**
 * Revoke all ability grants (active and passive) from a specific equipment instance.
 * Idempotent: calling with an instanceId that has no matching grants is a no-op.
 */
export function revokeEquipmentAbilityGrantsCore(
  world: GameWorld,
  holderEid: number,
  instanceId: EquipmentInstanceId | GeneratedEquipmentInstanceId,
): void {
  const state = world.abilityStatesByEntity.get(holderEid);
  if (state === undefined) return;

  const isMatchingSource = (s: AbilityGrantSource): boolean =>
    (s.kind === 'equipment' || s.kind === 'generated-equipment') && s.instanceId === instanceId;

  for (const abilityId of [...state.activeAbilityGrantSources.keys()]) {
    const sources = state.activeAbilityGrantSources.get(abilityId);
    if (sources === undefined) continue;
    const remaining = sources.filter((s) => !isMatchingSource(s));
    if (remaining.length === sources.length) continue;
    if (remaining.length > 0) {
      state.activeAbilityGrantSources.set(abilityId, remaining);
    } else {
      state.activeAbilityGrantSources.delete(abilityId);
      const idx = state.equippedActiveAbilityIds.indexOf(abilityId);
      if (idx !== -1) {
        state.equippedActiveAbilityIds.splice(idx, 1);
      }
    }
  }

  for (const abilityId of [...state.passiveAbilityGrantSources.keys()]) {
    const sources = state.passiveAbilityGrantSources.get(abilityId);
    if (sources === undefined) continue;
    const remaining = sources.filter((s) => !isMatchingSource(s));
    if (remaining.length === sources.length) continue;
    if (remaining.length > 0) {
      state.passiveAbilityGrantSources.set(abilityId, remaining);
    } else {
      state.passiveAbilityGrantSources.delete(abilityId);
      const idx = state.passiveAbilityIds.indexOf(abilityId);
      if (idx !== -1) {
        state.passiveAbilityIds.splice(idx, 1);
      }
    }
  }
}
