import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  addGeneratedEquipmentToBag,
  equip,
  equipFromBag,
  getEquipmentState,
} from '../../src/core/systems/equipmentSystem.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID,
  FLOOR2_SETTLEMENT_FOUND_GOAL_ID,
} from '../../src/game/floor2Scenario.js';
import {
  getEquipmentDefForStarterWeapon,
  MERCHANTS_CHARM_DEF,
} from '../../src/shared/equipmentDefs.js';
import { FLOOR2_FIND_SETTLEMENT_QUEST_ID } from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  createGeneratedEquipmentInstance,
  snapshotGeneratedEquipmentRegistry,
} from '../../src/core/generated-equipment-registry.js';
import {
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
  generatedEquipmentRunKeyFromSeed,
} from '../../src/shared/generated-equipment-types.js';
import { getActiveWeaponSnapshot } from '../../src/core/active-weapon.js';
import { generatedEquipmentInput } from '../fixtures/generated-equipment.js';

describe('Floor 1 to Floor 2 production transition', () => {
  it('creates Floor 2 with the completed player build and Broker starter chain', () => {
    const floor1Options = createFloorMainSceneOptions('floor1');
    const floor1 = createTestWorld({ seed: 42 });
    const floor1Player = spawnPlayer(floor1, 0, 0);
    floor1Options.configureWorld?.(floor1, floor1Player);
    floor1Options.selectLoadoutOption?.(floor1, 0);

    const sword = getEquipmentDefForStarterWeapon('sword');
    expect(sword).toBeDefined();
    expect(equip(floor1, floor1Player, MERCHANTS_CHARM_DEF, { force: true }).ok).toBe(true);
    floor1.playerLevel = { xp: 321, level: 7, unspentPoints: 4, pointsPerLevel: 3 };
    floor1.playerGold = 99;
    floor1.stores.coreStatPoints.strength[floor1Player] = 6;
    floor1.stores.coreStatPoints.constitution[floor1Player] = 5;
    floor1.stores.health.current[floor1Player] = 137;
    floor1.stores.health.max[floor1Player] = 260;
    floor1.inventories.get(floor1Player)!.slots.push({
      itemId: 'throwing-knife',
      quantity: 3,
    });
    floor1.featureUnlocks = { inventory: true, equipment: true, spells: true };

    const objective = floor1.floorScenario!.objective;
    objective.staircaseSpawned = true;
    objective.staircaseUnlocked = true;
    objective.staircaseDiscovered = false;
    expect(floor1Options.onStairDescend?.(floor1, floor1Player)).toBe(true);
    expect(floor1.floorScenario?.runSummary?.outcome).toBe('cleared_floor');

    const floor2Options = floor1Options.onFloor1Cleared?.(floor1, floor1Player);
    expect(floor2Options).toBeDefined();
    const floor2 = createTestWorld({ seed: 42, floor: 2 });
    const floor2Player = spawnPlayer(floor2, 0, 0);
    floor2Options?.configureWorld?.(floor2, floor2Player);

    expect(floor2.floorId).toBe('floor2');
    expect(floor2.floor).toBe(2);
    expect(floor2.state).toBe('playing');
    expect(floor2.playerLevel).toEqual(floor1.playerLevel);
    expect(floor2.playerGold).toBe(99);
    expect(floor2.stores.coreStatPoints.strength[floor2Player]).toBe(6);
    expect(floor2.stores.coreStatPoints.constitution[floor2Player]).toBe(5);
    expect(floor2.stores.health.current[floor2Player]).toBe(137);
    expect(floor2.stores.health.max[floor2Player]).toBe(260);
    expect(floor2.inventories.get(floor2Player)).toEqual(floor1.inventories.get(floor1Player));

    const floor1Equipment = getEquipmentState(floor1, floor1Player);
    const floor2Equipment = getEquipmentState(floor2, floor2Player);
    const equippedItemIds = (state: typeof floor1Equipment) =>
      new Set([...(state?.instances.values() ?? [])].map((instance) => instance.def.id));
    expect(equippedItemIds(floor2Equipment)).toEqual(equippedItemIds(floor1Equipment));
    expect(equippedItemIds(floor2Equipment)).toEqual(new Set([sword!.id, MERCHANTS_CHARM_DEF.id]));

    expect(floor2.questLog.get(FLOOR2_FIND_SETTLEMENT_QUEST_ID)).toMatchObject({
      status: 'active',
      tracked: true,
    });
    expect(floor2.goalFlags.get(FLOOR2_SETTLEMENT_FOUND_GOAL_ID)).toBe(false);
    expect(floor2.goalFlags.get(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID)).toBe(false);
    expect(floor2.floorExtendedState?.settlement?.brokerEid).toBeDefined();
  });

  it('preserves Floor 2 mandatory feature unlocks even when the snapshot has them false', () => {
    // A valid Floor 1 run can reach the stairs without completing the
    // inventory/equipment/spells progressive unlock paths. Carrying over that
    // snapshot must not turn off the Floor 2 mandatory unlocks that
    // initializeFloor2Scenario latches to true before restore runs.
    const floor1Options = createFloorMainSceneOptions('floor1');
    const floor1 = createTestWorld({ seed: 42 });
    const floor1Player = spawnPlayer(floor1, 0, 0);
    floor1Options.configureWorld?.(floor1, floor1Player);
    floor1Options.selectLoadoutOption?.(floor1, 0);

    // Player reached the stairs without ever triggering the progressive unlocks.
    floor1.featureUnlocks = { inventory: false, equipment: false, spells: false };

    const objective = floor1.floorScenario!.objective;
    objective.staircaseSpawned = true;
    objective.staircaseUnlocked = true;
    objective.staircaseDiscovered = false;
    expect(floor1Options.onStairDescend?.(floor1, floor1Player)).toBe(true);

    const floor2Options = floor1Options.onFloor1Cleared?.(floor1, floor1Player);
    expect(floor2Options).toBeDefined();
    const floor2 = createTestWorld({ seed: 42, floor: 2 });
    const floor2Player = spawnPlayer(floor2, 0, 0);
    floor2Options?.configureWorld?.(floor2, floor2Player);

    // All three mandatory Floor 2 unlocks must remain true regardless of the
    // snapshot's values.
    expect(floor2.featureUnlocks.inventory).toBe(true);
    expect(floor2.featureUnlocks.equipment).toBe(true);
    expect(floor2.featureUnlocks.spells).toBe(true);
  });

  it('carries exact generated registry references and frozen runtime state through the real transition callbacks', () => {
    const runKey = generatedEquipmentRunKeyFromSeed(42);
    const floor1Options = createFloorMainSceneOptions('floor1');
    const floor1 = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const floor1Player = spawnPlayer(floor1, 0, 0);
    floor1Options.configureWorld?.(floor1, floor1Player);
    floor1Options.selectLoadoutOption?.(floor1, 0);
    const equipped = createGeneratedEquipmentInstance(
      floor1,
      generatedEquipmentInput({
        baseId: 'weapon.floor-transition',
        slots: ['mainHand'],
        grants: true,
        weapon: true,
      }),
    );
    const bundledCommon = createGeneratedEquipmentInstance(
      floor1,
      generatedEquipmentInput({
        baseId: 'armor.floor-transition-reward',
        slots: ['feet'],
        rarity: 'common',
      }),
    );
    expect(addGeneratedEquipmentToBag(floor1, floor1Player, equipped.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        floor1,
        floor1Player,
        { kind: 'generated-instance', instanceKey: equipped.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);
    // A persisted reward bundle is only valid for a real, unlocked-but-unclaimed
    // tier1 equipment achievement and must hold exactly one instance whose
    // rarity is a member of that tier's allowed pool (fail-closed carryover
    // contract — tier1 is common-only).
    floor1.achievements.unlockedIds.add('floor2-field-kit');
    floor1.generatedEquipmentRewardBundles.set('floor2-field-kit', {
      schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
      achievementId: 'floor2-field-kit',
      tier: 'tier1',
      instanceKeys: [bundledCommon.instanceId],
    });
    const floor1Registry = snapshotGeneratedEquipmentRegistry(floor1);
    const objective = floor1.floorScenario!.objective;
    objective.staircaseSpawned = true;
    objective.staircaseUnlocked = true;
    objective.staircaseDiscovered = false;
    expect(floor1Options.onStairDescend?.(floor1, floor1Player)).toBe(true);

    const floor2Options = floor1Options.onFloor1Cleared?.(floor1, floor1Player);
    expect(floor2Options?.generatedEquipmentRunKey).toBe(runKey);
    const floor2 = createTestWorld({
      seed: floor2Options?.worldSeed,
      floor: 2,
      generatedEquipmentRunKey: floor2Options?.generatedEquipmentRunKey,
    });
    const floor2Player = spawnPlayer(floor2, 0, 0);
    floor2Options?.configureWorld?.(floor2, floor2Player);

    const floor2Registry = snapshotGeneratedEquipmentRegistry(floor2);
    expect(floor2Registry.runKey).toBe(floor1Registry.runKey);
    expect(floor2Registry.generationPolicy).toEqual(floor1Registry.generationPolicy);
    expect(floor2Registry.generationPolicyFingerprint).toBe(
      floor1Registry.generationPolicyFingerprint,
    );
    const floor2InstancesById = new Map(
      floor2Registry.instances.map((instance) => [instance.instanceId, instance]),
    );
    for (const instance of floor1Registry.instances) {
      expect(floor2InstancesById.get(instance.instanceId)).toEqual(instance);
    }
    expect(floor2Registry.nextOrdinal).toBeGreaterThanOrEqual(floor1Registry.nextOrdinal);
    expect(getEquipmentState(floor2, floor2Player)?.equipped.mainHand).toBe(equipped.instanceId);
    expect(getActiveWeaponSnapshot(floor2)).toEqual(equipped.frozen.activeWeaponSnapshot);
    expect(floor2.abilityStatesByEntity.get(floor2Player)?.equippedActiveAbilityIds).toContain(
      'magic-missile',
    );
    expect(floor2.generatedEquipmentRewardBundles.get('floor2-field-kit')).toEqual({
      schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
      achievementId: 'floor2-field-kit',
      tier: 'tier1',
      instanceKeys: [bundledCommon.instanceId],
    });
    expect(floor2.questLog.get(FLOOR2_FIND_SETTLEMENT_QUEST_ID)?.status).toBe('active');
    expect(floor2.goalFlags.get(FLOOR2_SETTLEMENT_FOUND_GOAL_ID)).toBe(false);
  });
});
