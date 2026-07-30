import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  addGeneratedEquipmentToBag,
  equipFromBag,
  getEquipmentState,
  getEffectiveStats,
} from '../../src/core/systems/equipmentSystem.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { getEntityEncumbranceSnapshot } from '../../src/core/encumbrance.js';
import { runSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { initializeFloor2Scenario } from '../../src/game/floor2Scenario.js';
import {
  getOrCreateAbilityState,
  grantAbilitySources,
} from '../../src/game/systems/abilitySystem.js';
import {
  ACTIVE_ABILITY_SLOT_LIMIT,
  equipmentAbilityGrantSourceId,
  learnedAbilityGrantSourceId,
} from '../../src/shared/abilities.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  type GeneratedEquipmentCreateInputV1,
} from '../../src/shared/generated-equipment-types.js';
import { createInputState } from '../../src/shared/input.js';
import { hasGeneratedEquipmentReference } from '../../src/shared/inventory.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('generated equipment real-pipeline integration', () => {
  it('preserves exact equipped identity, effective stats, and weight through a visual simulation step', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'b2-pipeline-test' });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    const input: GeneratedEquipmentCreateInputV1 = {
      baseId: 'armor.pipeline-helm',
      itemLevel: 4,
      rarity: 'common',
      enhancementLevel: 0,
      resolvedEffects: [],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Pipeline Helm',
        artKey: 'equipment.pipeline-helm',
        slots: ['head'],
        tags: ['armor'],
        weightLb: 18,
        statBonuses: { armor: 6 },
        abilityGrants: [],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    };
    const generated = createGeneratedEquipmentInstance(world, input);
    expect(addGeneratedEquipmentToBag(world, player, generated.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        world,
        player,
        { kind: 'generated-instance', instanceKey: generated.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);

    runSimulationStep(world, createInputState());

    expect(getEquipmentState(world, player)!.equipped.head).toBe(generated.instanceId);
    expect(getEffectiveStats(world, player).armor).toBe(6);
    expect(getEntityEncumbranceSnapshot(world, player).equippedWeightLb).toBe(18);
  });

  it('displaces both hand slots and cleans up generated-equipment grants at the real slot cap', () => {
    const world = createTestWorld({ floor: 2, generatedEquipmentRunKey: 'b2-pipeline-grants' });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);
    expect(world.featureUnlocks.inventory).toBe(true);
    expect(world.featureUnlocks.equipment).toBe(true);
    expect(world.featureUnlocks.spells).toBe(true);
    expect(world.floor2EquipmentFlags.floor2EquipmentRegistry).toBe(true);
    expect(world.floor2EquipmentFlags.floor2EquipmentCatalog).toBe(true);
    expect(world.floor2EquipmentFlags.floor2EquipmentRewards).toBe(true);
    expect(world.floor2EquipmentFlags.floor2EquipmentEconomy).toBe(true);
    expect(world.floor2EquipmentFlags.floor2EquipmentAiMaintenance).toBe(true);
    const input = createInputState();
    const floor2Options = createFloorMainSceneOptions('floor2');
    const bag = world.inventories.get(player)!;
    const prefilledActiveAbilityIds = [
      'battle-focus',
      'bless',
      'curse',
      'fireball',
      'frost-nova',
      'haste',
      'heal',
      'magic-missile',
      'pulse-shield',
      'stoneskin',
    ];
    expect(prefilledActiveAbilityIds.length).toBe(ACTIVE_ABILITY_SLOT_LIMIT);
    for (const abilityId of prefilledActiveAbilityIds) {
      grantAbilitySources(
        world,
        player,
        [{ kind: 'active', abilityId, sourceId: learnedAbilityGrantSourceId(abilityId) }],
        { configureActives: 'require-slots' },
      );
    }

    const mainHandItem = createGeneratedEquipmentInstance(world, {
      baseId: 'weapon.pipeline-main-hand',
      itemLevel: 3,
      rarity: 'common',
      enhancementLevel: 0,
      resolvedEffects: [],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Pipeline Main Hand',
        artKey: 'equipment.pipeline-main-hand',
        slots: ['mainHand'],
        tags: ['weapon'],
        weightLb: 6,
        statBonuses: {},
        abilityGrants: [],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    });
    const offHandItem = createGeneratedEquipmentInstance(world, {
      baseId: 'weapon.pipeline-off-hand',
      itemLevel: 3,
      rarity: 'common',
      enhancementLevel: 0,
      resolvedEffects: [],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Pipeline Off Hand',
        artKey: 'equipment.pipeline-off-hand',
        slots: ['offHand'],
        tags: ['weapon'],
        weightLb: 6,
        statBonuses: {},
        abilityGrants: [],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    });
    const grantedTwoHander = createGeneratedEquipmentInstance(world, {
      baseId: 'weapon.pipeline-two-hander',
      itemLevel: 5,
      rarity: 'rare',
      enhancementLevel: 0,
      resolvedEffects: [
        {
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId: 'grant-vampiric-touch',
          effectOrdinal: 0,
          unitCost: 1,
          kind: 'abilityGrant',
          grantId: 'vampiric-touch',
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
        displayName: 'Pipeline Greatblade',
        artKey: 'equipment.pipeline-greatblade',
        slots: ['mainHand', 'offHand'],
        tags: ['weapon'],
        weightLb: 22,
        statBonuses: {},
        abilityGrants: ['vampiric-touch'],
        passiveGrants: ['veteran-instinct'],
        activeWeaponSnapshot: null,
      },
    });
    const plainTwoHander = createGeneratedEquipmentInstance(world, {
      baseId: 'weapon.pipeline-spare-two-hander',
      itemLevel: 5,
      rarity: 'common',
      enhancementLevel: 0,
      resolvedEffects: [],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Pipeline Spare Greatblade',
        artKey: 'equipment.pipeline-spare-greatblade',
        slots: ['mainHand', 'offHand'],
        tags: ['weapon'],
        weightLb: 20,
        statBonuses: {},
        abilityGrants: [],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    });

    for (const instance of [mainHandItem, offHandItem, grantedTwoHander, plainTwoHander]) {
      expect(addGeneratedEquipmentToBag(world, player, instance.instanceId).ok).toBe(true);
    }
    expect(
      equipFromBag(
        world,
        player,
        { kind: 'generated-instance', instanceKey: mainHandItem.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);
    expect(
      equipFromBag(
        world,
        player,
        { kind: 'generated-instance', instanceKey: offHandItem.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);

    runSimulationStep(world, input, floor2Options);

    const baselineStats = getEffectiveStats(world, player);

    expect(
      equipFromBag(
        world,
        player,
        { kind: 'generated-instance', instanceKey: grantedTwoHander.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);

    runSimulationStep(world, input, floor2Options);
    runSimulationStep(world, input, floor2Options);

    const equippedWithGrants = getEquipmentState(world, player)!.equipped;
    const grantedState = getOrCreateAbilityState(world, player);
    expect(equippedWithGrants.mainHand).toBe(grantedTwoHander.instanceId);
    expect(equippedWithGrants.offHand).toBe(grantedTwoHander.instanceId);
    expect(hasGeneratedEquipmentReference(bag, mainHandItem.instanceId)).toBe(true);
    expect(hasGeneratedEquipmentReference(bag, offHandItem.instanceId)).toBe(true);
    expect(grantedState.equippedActiveAbilityIds).toHaveLength(ACTIVE_ABILITY_SLOT_LIMIT);
    expect(grantedState.equippedActiveAbilityIds).toEqual(
      expect.arrayContaining(prefilledActiveAbilityIds),
    );
    expect(grantedState.equippedActiveAbilityIds).not.toContain('vampiric-touch');
    expect(grantedState.ownedActiveAbilityIds).toContain('vampiric-touch');
    expect(grantedState.passiveAbilityIds).toContain('veteran-instinct');
    expect(getEffectiveStats(world, player).armor).toBe(baselineStats.armor + 2);
    expect(getEffectiveStats(world, player).pickupRange).toBe(baselineStats.pickupRange + 0.75);
    expect(grantedState.grantOwnership.activeSourcesByAbilityId.get('vampiric-touch')).toEqual(
      new Set([equipmentAbilityGrantSourceId(grantedTwoHander.instanceId, 0)]),
    );
    expect(grantedState.grantOwnership.passiveSourcesByAbilityId.get('veteran-instinct')).toEqual(
      new Set([equipmentAbilityGrantSourceId(grantedTwoHander.instanceId, 1)]),
    );

    expect(
      equipFromBag(
        world,
        player,
        { kind: 'generated-instance', instanceKey: plainTwoHander.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);

    runSimulationStep(world, input, floor2Options);
    runSimulationStep(world, input, floor2Options);

    const equippedAfterDisplace = getEquipmentState(world, player)!.equipped;
    const revokedState = getOrCreateAbilityState(world, player);
    expect(equippedAfterDisplace.mainHand).toBe(plainTwoHander.instanceId);
    expect(equippedAfterDisplace.offHand).toBe(plainTwoHander.instanceId);
    expect(hasGeneratedEquipmentReference(bag, grantedTwoHander.instanceId)).toBe(true);
    expect(revokedState.equippedActiveAbilityIds).toHaveLength(ACTIVE_ABILITY_SLOT_LIMIT);
    expect(revokedState.equippedActiveAbilityIds).toEqual(
      expect.arrayContaining(prefilledActiveAbilityIds),
    );
    expect(revokedState.equippedActiveAbilityIds).not.toContain('vampiric-touch');
    expect(revokedState.ownedActiveAbilityIds).toHaveLength(ACTIVE_ABILITY_SLOT_LIMIT);
    expect(revokedState.ownedActiveAbilityIds).toEqual(
      expect.arrayContaining(prefilledActiveAbilityIds),
    );
    expect(revokedState.ownedActiveAbilityIds).not.toContain('vampiric-touch');
    expect(revokedState.passiveAbilityIds).not.toContain('veteran-instinct');
    expect(getEffectiveStats(world, player).armor).toBe(baselineStats.armor);
    expect(getEffectiveStats(world, player).pickupRange).toBe(baselineStats.pickupRange);
    expect(
      revokedState.grantOwnership.activeSourcesByAbilityId.get('vampiric-touch'),
    ).toBeUndefined();
    expect(
      revokedState.grantOwnership.passiveSourcesByAbilityId.get('veteran-instinct'),
    ).toBeUndefined();
  });
});
