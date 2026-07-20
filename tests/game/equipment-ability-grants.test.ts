import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import {
  grantEquipmentAbilitySources,
  revokeEquipmentAbilitySources,
} from '../../src/game/equipment-ability-grants.js';
import {
  getOrCreateAbilityState,
  grantAbilitySources,
  memorizeSpell,
} from '../../src/game/systems/abilitySystem.js';
import {
  equipmentAbilityGrantSourceId,
  learnedAbilityGrantSourceId,
} from '../../src/shared/abilities.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
} from '../../src/shared/generated-equipment-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('generated equipment ability grants', () => {
  it('grants and revokes a real frozen registry instance by stable identity', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'ability-grants' });
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

  it('is idempotent: revoking twice does not throw', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'ability-idempotent' });
    const player = spawnPlayer(world, 0, 0);
    const instance = createGeneratedEquipmentInstance(world, {
      baseId: 'armor.ceremonial-coat',
      itemLevel: 3,
      rarity: 'uncommon',
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
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    });

    grantEquipmentAbilitySources(world, player, instance.instanceId);
    expect(() => revokeEquipmentAbilitySources(world, player, instance.instanceId)).not.toThrow();
    expect(() => revokeEquipmentAbilitySources(world, player, instance.instanceId)).not.toThrow();
  });

  it('keeps learned ability equipped after equipment grant is revoked', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'ability-keep-learned' });
    const player = spawnPlayer(world, 0, 0);
    memorizeSpell(world, player, 'fireball');
    const instance = createGeneratedEquipmentInstance(world, {
      baseId: 'armor.ceremonial-coat',
      itemLevel: 3,
      rarity: 'uncommon',
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
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    });

    grantEquipmentAbilitySources(world, player, instance.instanceId);
    revokeEquipmentAbilitySources(world, player, instance.instanceId);
    const state = getOrCreateAbilityState(world, player);
    expect(state.equippedActiveAbilityIds).toContain('fireball');
    expect(state.learnedSpellIds).toContain('fireball');
  });
});
