import { requireGeneratedEquipmentInstance } from '../core/generated-equipment-registry.js';
import type { GameWorld } from '../core/world.js';
import {
  equipmentAbilityGrantSourceId,
  type AbilityGrantSourceId,
  type GeneratedEquipmentInstanceId,
} from '../shared/index.js';
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
    if (!('kind' in effect) || (effect.kind !== 'abilityGrant' && effect.kind !== 'passiveGrant')) {
      return [];
    }
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
): readonly AbilityGrantSourceId[] {
  const ownership = world.abilityStatesByEntity.get(holderEid)?.grantOwnership;
  if (ownership === undefined) return [];
  const sourcePrefix = `equipment:${instanceId}:`;
  const sourceIds: AbilityGrantSourceId[] = [];
  for (const [, sources] of ownership.activeSourcesByAbilityId) {
    for (const sourceId of sources) {
      if (sourceId.startsWith(sourcePrefix)) {
        sourceIds.push(sourceId);
      }
    }
  }
  for (const [, sources] of ownership.passiveSourcesByAbilityId) {
    for (const sourceId of sources) {
      if (sourceId.startsWith(sourcePrefix)) {
        sourceIds.push(sourceId);
      }
    }
  }
  return sourceIds;
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
