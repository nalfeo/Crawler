/**
 * Core-level generated-equipment ability grant/revoke helpers.
 *
 * These functions implement the canonical state mutations for granting and
 * revoking generated-equipment ability sources. They operate directly on
 * `world.abilityStatesByEntity` without catalog validation — callers in the
 * game layer (`grantGeneratedEquipmentActiveAbility` /
 * `grantGeneratedEquipmentPassiveAbility`) must perform preflight validation
 * using `getAbilityDefinition` before calling these.
 *
 * Having the mutations here allows `equipmentSystem` (core layer) and
 * `abilitySystem` (game layer) to share one implementation and avoid
 * divergence between the two equip pipelines (resolvedEffects vs.
 * frozen.abilityGrants / frozen.passiveGrants).
 */

import {
  ACTIVE_ABILITY_SLOT_LIMIT,
  createEmptyAbilityState,
  type AbilityGrantSource,
  type AbilityState,
} from '../shared/abilities.js';
import type { GeneratedEquipmentInstanceId } from '../shared/generated-equipment-types.js';
import type { GameWorld } from './world.js';

function getOrCreateAbilityStateForEntity(world: GameWorld, holderEid: number): AbilityState {
  const existing = world.abilityStatesByEntity.get(holderEid);
  if (existing !== undefined) return existing;
  const created = createEmptyAbilityState();
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
 *
 * Idempotent: repeated calls with the same `(instanceId, effectOrdinal)` pair
 * are no-ops.
 *
 * Performs NO catalog validation — callers in the game layer must preflight
 * with `getAbilityDefinition` before calling this.
 */
export function coreGrantGeneratedEquipmentActiveAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  instanceId: GeneratedEquipmentInstanceId,
  effectOrdinal: number,
): void {
  if (!abilityId) throw new Error('abilityId must be a non-empty string');
  const state = getOrCreateAbilityStateForEntity(world, holderEid);
  const source: AbilityGrantSource = { kind: 'generated-equipment', instanceId, effectOrdinal };
  // Idempotent: skip if this exact (instanceId, effectOrdinal) pair is already recorded.
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
    // Already equipped (from another source) — just track the new source.
    addActiveGrantSource(state, abilityId, source);
    return;
  }
  if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
    // Slot cap reached — record as known-inactive: source tracked, not equipped.
    addActiveGrantSource(state, abilityId, source);
    return;
  }
  state.equippedActiveAbilityIds.push(abilityId);
  addActiveGrantSource(state, abilityId, source);
}

/**
 * Grant a passive ability from a generated-equipment instance.
 *
 * Idempotent: repeated calls with the same `(instanceId, effectOrdinal)` pair
 * are no-ops.
 *
 * Performs NO catalog validation — callers in the game layer must preflight
 * with `getAbilityDefinition` before calling this.
 */
export function coreGrantGeneratedEquipmentPassiveAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  instanceId: GeneratedEquipmentInstanceId,
  effectOrdinal: number,
): void {
  if (!abilityId) throw new Error('abilityId must be a non-empty string');
  const state = getOrCreateAbilityStateForEntity(world, holderEid);
  const source: AbilityGrantSource = { kind: 'generated-equipment', instanceId, effectOrdinal };
  // Idempotent: skip if this exact (instanceId, effectOrdinal) pair is already recorded.
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
