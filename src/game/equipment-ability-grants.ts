import { requireGeneratedEquipmentInstance } from '../core/generated-equipment-registry.js';
import type { GameWorld } from '../core/world.js';
import { equipmentAbilityGrantSourceId } from '../shared/abilities.js';
import {
  isValidGeneratedInstanceId,
  type GeneratedEquipmentInstanceId,
} from '../shared/generated-equipment-types.js';
import {
  grantAbilitySources,
  revokeAbilitySources,
  type AbilityGrantRequest,
} from './systems/abilitySystem.js';

function grantRequestsForInstance(
  world: GameWorld,
  instanceId: GeneratedEquipmentInstanceId,
): readonly AbilityGrantRequest[] {
  const instance = requireGeneratedEquipmentInstance(world, instanceId);
  return instance.resolvedEffects.flatMap((effect): AbilityGrantRequest[] => {
    if (!('kind' in effect)) return [];
    if (effect.kind !== 'abilityGrant' && effect.kind !== 'passiveGrant') return [];
    return [
      {
        kind: effect.kind === 'passiveGrant' ? 'passive' : 'active',
        abilityId: effect.grantId,
        sourceId: equipmentAbilityGrantSourceId(instance.instanceId, effect.effectOrdinal),
      },
    ];
  });
}

function revocationRequestsForInstance(
  world: GameWorld,
  holderEid: number,
  instanceId: GeneratedEquipmentInstanceId,
): readonly AbilityGrantRequest[] {
  // Validate the full instance ID before using it as a source prefix.  A
  // partial / malformed ID (e.g. "gei:v1:run") would otherwise match every
  // source that begins with that substring and revoke grants from unrelated
  // instances instead of failing explicitly.
  if (!isValidGeneratedInstanceId(instanceId)) {
    throw new Error(`Invalid generated equipment instance ID: ${instanceId}`);
  }
  const ownership = world.abilityStatesByEntity.get(holderEid)?.grantOwnership;
  if (ownership === undefined) return [];
  const sourcePrefix = `equipment:${instanceId}:`;
  const requests: AbilityGrantRequest[] = [];
  for (const [abilityId, sources] of ownership.activeSourcesByAbilityId) {
    for (const sourceId of sources) {
      if (sourceId.startsWith(sourcePrefix)) {
        requests.push({ kind: 'active', abilityId, sourceId });
      }
    }
  }
  for (const [abilityId, sources] of ownership.passiveSourcesByAbilityId) {
    for (const sourceId of sources) {
      if (sourceId.startsWith(sourcePrefix)) {
        requests.push({ kind: 'passive', abilityId, sourceId });
      }
    }
  }
  return requests;
}

export function grantEquipmentAbilitySources(
  world: GameWorld,
  holderEid: number,
  instanceId: GeneratedEquipmentInstanceId,
): void {
  grantAbilitySources(world, holderEid, grantRequestsForInstance(world, instanceId), {
    configureActives: 'fill-open-slots',
  });
}

export function revokeEquipmentAbilitySources(
  world: GameWorld,
  holderEid: number,
  instanceId: GeneratedEquipmentInstanceId,
): void {
  revokeAbilitySources(
    world,
    holderEid,
    revocationRequestsForInstance(world, holderEid, instanceId),
  );
}
