import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { equip, getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
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
});
