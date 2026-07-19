import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import {
  grantEquipmentAbilitySources,
  revokeEquipmentAbilitySources,
} from '../../src/game/equipment-ability-grants.js';
import { getOrCreateAbilityState, memorizeSpell } from '../../src/game/systems/abilitySystem.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
} from '../../src/shared/generated-equipment-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('generated equipment ability grants', () => {
  it('grants active and passive abilities from a frozen registry instance', () => {
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

    grantEquipmentAbilitySources(world, player, instance.instanceId);
    const state = getOrCreateAbilityState(world, player);
    expect(state.equippedActiveAbilityIds).toContain('fireball');
    expect(state.passiveAbilityIds).toContain('veteran-instinct');
    const activeSources = state.activeAbilityGrantSources.get('fireball');
    expect(activeSources).toBeDefined();
    expect(
      activeSources!.some(
        (s) =>
          s.kind === 'generated-equipment' &&
          s.instanceId === instance.instanceId &&
          s.effectOrdinal === 0,
      ),
    ).toBe(true);
  });

  it('revokes all grants from the equipment instance without affecting other sources', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'ability-revoke' });
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

    grantEquipmentAbilitySources(world, player, instance.instanceId);
    revokeEquipmentAbilitySources(world, player, instance.instanceId);
    const state = getOrCreateAbilityState(world, player);
    expect(state.equippedActiveAbilityIds).not.toContain('fireball');
    expect(state.passiveAbilityIds).not.toContain('veteran-instinct');
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
    // Grant fireball via the learned path first
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
    // Learned source should still keep fireball equipped
    expect(state.equippedActiveAbilityIds).toContain('fireball');
    expect(state.learnedSpellIds).toContain('fireball');
  });
});
