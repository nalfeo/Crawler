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
  ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
  ACTIVE_ABILITY_SLOT_LIMIT,
  equipmentAbilityGrantSourceId,
  type AbilityStateLike,
  createEmptyAbilityState,
  type AbilityGrantSource,
  type AbilityState,
} from '../shared/abilities.js';
import {
  isValidGeneratedInstanceId,
  type GeneratedEquipmentInstanceId,
} from '../shared/generated-equipment-types.js';
import type { GameWorld } from './world.js';

function getOrCreateAbilityStateForEntity(world: GameWorld, holderEid: number): AbilityState {
  const existing = world.abilityStatesByEntity.get(holderEid);
  if (existing !== undefined) {
    const draft = existing as Partial<AbilityStateLike>;
    draft.learnedSpellIds ??= [];
    draft.equippedActiveAbilityIds ??= [];
    draft.ownedActiveAbilityIds ??= [];
    draft.passiveAbilityIds ??= [];
    draft.cooldownByAbilityId ??= new Map();
    draft.cooldownFramesByAbilityId ??= new Map();
    draft.appliedPassiveAbilityIds ??= new Set();
    draft.activeAbilityGrantSources ??= new Map();
    draft.passiveAbilityGrantSources ??= new Map();
    draft.grantOwnership ??= {
      schemaVersion: ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
      activeSourcesByAbilityId: new Map(),
      passiveSourcesByAbilityId: new Map(),
    };
    return draft as AbilityState;
  }
  const created = createEmptyAbilityState();
  world.abilityStatesByEntity.set(holderEid, created);
  return created;
}

function addActiveGrantSource(
  state: AbilityState,
  abilityId: string,
  source: AbilityGrantSource,
): void {
  const sourceMap =
    state.activeAbilityGrantSources ??
    (state.activeAbilityGrantSources = new Map<string, AbilityGrantSource[]>());
  const sources = sourceMap.get(abilityId);
  if (sources === undefined) {
    sourceMap.set(abilityId, [source]);
  } else if (
    !sources.some(
      (existing) =>
        existing.kind === 'generated-equipment' &&
        source.kind === 'generated-equipment' &&
        existing.instanceId === source.instanceId &&
        existing.effectOrdinal === source.effectOrdinal,
    )
  ) {
    sources.push(source);
  }
}

function addPassiveGrantSource(
  state: AbilityState,
  abilityId: string,
  source: AbilityGrantSource,
): void {
  const sourceMap =
    state.passiveAbilityGrantSources ??
    (state.passiveAbilityGrantSources = new Map<string, AbilityGrantSource[]>());
  const sources = sourceMap.get(abilityId);
  if (sources === undefined) {
    sourceMap.set(abilityId, [source]);
  } else if (
    !sources.some(
      (existing) =>
        existing.kind === 'generated-equipment' &&
        source.kind === 'generated-equipment' &&
        existing.instanceId === source.instanceId &&
        existing.effectOrdinal === source.effectOrdinal,
    )
  ) {
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
  const sourceId = equipmentAbilityGrantSourceId(instanceId, effectOrdinal);
  const ownership = state.grantOwnership!;
  const ownedSources =
    ownership.activeSourcesByAbilityId.get(abilityId) ?? new Set<typeof sourceId>();
  if (ownedSources.has(sourceId)) {
    return;
  }
  ownedSources.add(sourceId);
  ownership.activeSourcesByAbilityId.set(abilityId, ownedSources);
  addActiveGrantSource(state, abilityId, source);
  if (!(state.ownedActiveAbilityIds ?? []).includes(abilityId)) {
    (state.ownedActiveAbilityIds ??= []).push(abilityId);
  }
  if (state.equippedActiveAbilityIds.includes(abilityId)) {
    return;
  }
  if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
    return;
  }
  state.equippedActiveAbilityIds.push(abilityId);
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
  const sourceId = equipmentAbilityGrantSourceId(instanceId, effectOrdinal);
  const ownership = state.grantOwnership!;
  const ownedSources =
    ownership.passiveSourcesByAbilityId.get(abilityId) ?? new Set<typeof sourceId>();
  if (ownedSources.has(sourceId)) {
    return;
  }
  ownedSources.add(sourceId);
  ownership.passiveSourcesByAbilityId.set(abilityId, ownedSources);
  if (!state.passiveAbilityIds.includes(abilityId)) {
    state.passiveAbilityIds.push(abilityId);
  }
  addPassiveGrantSource(state, abilityId, source);
}

export function revokeEquipmentAbilityGrantsCore(
  world: GameWorld,
  holderEid: number,
  instanceId: GeneratedEquipmentInstanceId,
): void {
  if (!isValidGeneratedInstanceId(instanceId)) {
    throw new Error(`Invalid generated equipment instance ID: ${instanceId}`);
  }
  const state = world.abilityStatesByEntity.get(holderEid);
  if (state === undefined) return;
  const sourcePrefix = `equipment:${instanceId}:`;
  const ownership = state.grantOwnership;

  const activeSourceMap = state.activeAbilityGrantSources;
  if (activeSourceMap !== undefined) {
    for (const [abilityId, sources] of [...activeSourceMap]) {
      const remaining = sources.filter(
        (source) => source.kind !== 'generated-equipment' || source.instanceId !== instanceId,
      );
      if (remaining.length > 0) {
        activeSourceMap.set(abilityId, remaining);
      } else {
        activeSourceMap.delete(abilityId);
      }
    }
  }

  const passiveSourceMap = state.passiveAbilityGrantSources;
  if (passiveSourceMap !== undefined) {
    for (const [abilityId, sources] of [...passiveSourceMap]) {
      const remaining = sources.filter(
        (source) => source.kind !== 'generated-equipment' || source.instanceId !== instanceId,
      );
      if (remaining.length > 0) {
        passiveSourceMap.set(abilityId, remaining);
      } else {
        passiveSourceMap.delete(abilityId);
      }
    }
  }

  for (const [abilityId, sources] of [...(ownership?.activeSourcesByAbilityId ?? [])]) {
    for (const sourceId of [...sources]) {
      if (sourceId.startsWith(sourcePrefix)) {
        sources.delete(sourceId);
      }
    }
    if (sources.size > 0) continue;
    ownership!.activeSourcesByAbilityId.delete(abilityId);
    state.equippedActiveAbilityIds = state.equippedActiveAbilityIds.filter(
      (id) => id !== abilityId,
    );
    state.ownedActiveAbilityIds = (state.ownedActiveAbilityIds ?? []).filter(
      (id) => id !== abilityId,
    );
  }

  for (const [abilityId, sources] of [...(ownership?.passiveSourcesByAbilityId ?? [])]) {
    for (const sourceId of [...sources]) {
      if (sourceId.startsWith(sourcePrefix)) {
        sources.delete(sourceId);
      }
    }
    if (sources.size > 0) continue;
    ownership!.passiveSourcesByAbilityId.delete(abilityId);
    state.passiveAbilityIds = state.passiveAbilityIds.filter((id) => id !== abilityId);
    state.appliedPassiveAbilityIds.delete(abilityId);
    world.statModifiers = world.statModifiers.filter(
      (modifier) =>
        !(
          modifier.sourceType === 'ability' &&
          modifier.sourceId.startsWith(`${abilityId}:passive:${holderEid}:`)
        ),
    );
  }
}
