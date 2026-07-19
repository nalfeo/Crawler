import { requireGeneratedEquipmentInstance } from '../core/generated-equipment-registry.js';
import type { GameWorld } from '../core/world.js';
import type { GeneratedEquipmentInstanceId } from '../shared/generated-equipment-types.js';
import {
  grantEquipmentActiveAbility,
  grantEquipmentPassiveAbility,
  revokeEquipmentAbilityGrants,
} from './systems/abilitySystem.js';

/**
 * Grants all active and passive abilities from a generated equipment instance
 * to the specified entity. Idempotent: the underlying source-tracking in
 * {@link AbilityState} deduplicates repeated grants from the same source.
 *
 * Only effects with `kind === 'abilityGrant'` or `kind === 'passiveGrant'` are
 * processed; stat effects and legacy effects without a `kind` field are
 * silently skipped.
 */
export function grantEquipmentAbilitySources(
  world: GameWorld,
  holderEid: number,
  instanceId: GeneratedEquipmentInstanceId,
): void {
  const instance = requireGeneratedEquipmentInstance(world, instanceId);
  for (const effect of instance.resolvedEffects) {
    if (!('kind' in effect)) continue;
    if (effect.kind === 'abilityGrant') {
      grantEquipmentActiveAbility(world, holderEid, effect.grantId, instanceId);
    } else if (effect.kind === 'passiveGrant') {
      grantEquipmentPassiveAbility(world, holderEid, effect.grantId, instanceId);
    }
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
