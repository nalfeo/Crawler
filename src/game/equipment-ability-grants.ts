import { requireGeneratedEquipmentInstance } from '../core/generated-equipment-registry.js';
import type { GameWorld } from '../core/world.js';
import type { GeneratedEquipmentInstanceId } from '../shared/generated-equipment-types.js';
import {
  grantGeneratedEquipmentActiveAbility,
  grantGeneratedEquipmentPassiveAbility,
  revokeEquipmentAbilityGrants,
} from './systems/abilitySystem.js';
import { getAbilityDefinition } from './abilities/registry.js';

/**
 * Grants all active and passive abilities from a generated equipment instance
 * to the specified entity.
 *
 * Iterates `frozen.abilityGrants` and `frozen.passiveGrants` as the single
 * authoritative consumer-visible contract (resolving the dual-authority problem
 * between `resolvedEffects` and the frozen arrays). The array index is used as
 * the `effectOrdinal` so each grant has a distinct identity.
 *
 * The operation is **preflight-validated** before any state mutation: if any
 * ability ID is unknown or has the wrong kind (active vs. passive), the call
 * throws without modifying ability state.
 *
 * Each underlying call to {@link grantGeneratedEquipmentActiveAbility} /
 * {@link grantGeneratedEquipmentPassiveAbility} is idempotent: calling this
 * wrapper twice for the same instance produces no duplicate source entries.
 * Active abilities that cannot fit in the ACTIVE_ABILITY_SLOT_LIMIT slots are
 * recorded as *known-inactive* (source-tracked but not equipped) rather than
 * throwing.
 */
export function grantEquipmentAbilitySources(
  world: GameWorld,
  holderEid: number,
  instanceId: GeneratedEquipmentInstanceId,
): void {
  const instance = requireGeneratedEquipmentInstance(world, instanceId);
  const { abilityGrants, passiveGrants } = instance.frozen;

  // Preflight: validate all abilities before mutating any state so that a bad
  // catalog entry never leaves partial grants applied.
  for (const abilityId of abilityGrants) {
    const def = getAbilityDefinition(abilityId);
    if (def === undefined) throw new Error(`Unknown ability id: ${abilityId}`);
    if (def.kind === 'passive')
      throw new Error(`Ability ${abilityId} is passive; expected active grant`);
  }
  for (const abilityId of passiveGrants) {
    const def = getAbilityDefinition(abilityId);
    if (def === undefined) throw new Error(`Unknown ability id: ${abilityId}`);
    if (def.kind !== 'passive')
      throw new Error(`Ability ${abilityId} is not passive; expected passive grant`);
  }

  // Apply grants using the array index as effectOrdinal.
  for (let i = 0; i < abilityGrants.length; i++) {
    grantGeneratedEquipmentActiveAbility(world, holderEid, abilityGrants[i]!, instanceId, i);
  }
  for (let i = 0; i < passiveGrants.length; i++) {
    grantGeneratedEquipmentPassiveAbility(world, holderEid, passiveGrants[i]!, instanceId, i);
  }
}

/**
 * Revokes all ability grants (active and passive) that were made from the
 * given generated equipment instance. Abilities that also have other sources
 * (learned, skill) are kept; only the equipment source entry is removed.
 * Idempotent: a no-op if no grants from this instance exist.
 */
export function revokeEquipmentAbilitySources(
  world: GameWorld,
  holderEid: number,
  instanceId: GeneratedEquipmentInstanceId,
): void {
  revokeEquipmentAbilityGrants(world, holderEid, instanceId);
}
