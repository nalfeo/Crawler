import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import {
  grantEquipmentAbilitySources,
  revokeEquipmentAbilitySources,
} from '../../src/game/equipment-ability-grants.js';
import {
  forceActivateAbility,
  getOrCreateAbilityState,
  grantAbilitySources,
} from '../../src/game/systems/abilitySystem.js';
import { createFunTelemetryCollector } from '../../src/core/fun-telemetry.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
} from '../../src/shared/generated-equipment-types.js';
import {
  equipmentAbilityGrantSourceId,
  learnedAbilityGrantSourceId,
} from '../../src/shared/abilities.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('generated equipment ability grants', () => {
  it('grants and revokes a real frozen registry instance by stable identity', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'ability.grants' });
    const player = spawnPlayer(world, 0, 0);
    const instance = createGeneratedEquipmentInstance(world, {
      baseId: 'armor.ceremonial-coat',
      itemLevel: 3,
      rarity: 'rare',
      enhancementLevel: 0,
      resolvedEffects: [
        {
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId: 'grant-fireball',
          effectOrdinal: 0,
          unitCost: 1,
          kind: 'abilityGrant',
          grantId: 'fireball',
        },
        {
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId: 'grant-veteran-instinct',
          effectOrdinal: 1,
          unitCost: 1,
          kind: 'passiveGrant',
          grantId: 'veteran-instinct',
        },
      ],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Coat of Embers',
        artKey: 'armor.ceremonial-coat',
        slots: ['chest'],
        tags: ['armor'],
        weightLb: 4,
        statBonuses: {},
        abilityGrants: ['fireball'],
        passiveGrants: ['veteran-instinct'],
        activeWeaponSnapshot: null,
      },
    });
    expect(instance.instanceId).toBe('gei:v1:ability.grants:0');
    const learned = learnedAbilityGrantSourceId('fireball');
    grantAbilitySources(world, player, [
      { kind: 'active', abilityId: 'fireball', sourceId: learned },
    ]);

    grantEquipmentAbilitySources(world, player, instance.instanceId);
    grantEquipmentAbilitySources(world, player, instance.instanceId);
    let state = getOrCreateAbilityState(world, player);
    expect(state.grantOwnership.activeSourcesByAbilityId.get('fireball')).toEqual(
      new Set([learned, equipmentAbilityGrantSourceId(instance.instanceId, 0)]),
    );
    expect(state.grantOwnership.passiveSourcesByAbilityId.get('veteran-instinct')).toEqual(
      new Set([equipmentAbilityGrantSourceId(instance.instanceId, 1)]),
    );
    expect(state.equippedActiveAbilityIds).toEqual(['fireball']);
    world.funTelemetry = createFunTelemetryCollector();
    world.featureUnlocks.spells = true;
    expect(forceActivateAbility(world, player, 'fireball')).toBe(true);
    expect(world.funTelemetry.activations).toEqual([
      {
        activationId: 1,
        itemSources: [`generated-equipment-instance:${instance.instanceId}`, 'spell:fireball'],
      },
    ]);

    revokeEquipmentAbilitySources(world, player, instance.instanceId);
    revokeEquipmentAbilitySources(world, player, instance.instanceId);
    state = getOrCreateAbilityState(world, player);
    expect(state.grantOwnership.activeSourcesByAbilityId.get('fireball')).toEqual(
      new Set([learned]),
    );
    expect(state.equippedActiveAbilityIds).toEqual(['fireball']);
    expect(state.passiveAbilityIds).toEqual([]);
  });

  it('revokes authoritative sources even when the registry instance is unavailable', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'registry-teardown' });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const instance = createGeneratedEquipmentInstance(source, {
      baseId: 'armor.ceremonial-coat',
      itemLevel: 3,
      rarity: 'rare',
      enhancementLevel: 0,
      resolvedEffects: [
        {
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId: 'grant-fireball',
          effectOrdinal: 0,
          unitCost: 1,
          kind: 'abilityGrant',
          grantId: 'fireball',
        },
        {
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId: 'grant-veteran-instinct',
          effectOrdinal: 1,
          unitCost: 1,
          kind: 'passiveGrant',
          grantId: 'veteran-instinct',
        },
      ],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Teardown Coat',
        artKey: 'armor.ceremonial-coat',
        slots: ['chest'],
        tags: ['armor'],
        weightLb: 4,
        statBonuses: {},
        abilityGrants: ['fireball'],
        passiveGrants: ['veteran-instinct'],
        activeWeaponSnapshot: null,
      },
    });
    grantEquipmentAbilitySources(source, sourcePlayer, instance.instanceId);

    const target = createTestWorld();
    const targetPlayer = spawnPlayer(target, 0, 0);
    target.abilityStatesByEntity.set(targetPlayer, source.abilityStatesByEntity.get(sourcePlayer)!);

    expect(() =>
      revokeEquipmentAbilitySources(target, targetPlayer, instance.instanceId),
    ).not.toThrow();
    const state = getOrCreateAbilityState(target, targetPlayer);
    expect(state.equippedActiveAbilityIds).toEqual([]);
    expect(state.passiveAbilityIds).toEqual([]);
    expect(() =>
      revokeEquipmentAbilitySources(target, targetPlayer, instance.instanceId),
    ).not.toThrow();
  });

  it('rejects a malformed instanceId before prefix-scanning ownership', () => {
    // A partial ID like "gei:v1:run" would match every source for that run and
    // could revoke grants from multiple instances instead of failing explicitly.
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);

    expect(() =>
      revokeEquipmentAbilitySources(
        world,
        player,
        'gei:v1:run' as Parameters<typeof revokeEquipmentAbilitySources>[2],
      ),
    ).toThrow(/invalid generated equipment instance id/i);
  });
});
