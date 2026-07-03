import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  FLOOR2_STAIRS_POPPED_GOAL_ID,
  FLOOR2_VICTORY_GOAL_ID,
  floor2ObjectiveTick,
  initializeFloor2Bosses,
} from '../../src/game/floor2Scenario.js';
import { selectFloor2Roster } from '../../src/core/faction-relations.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

describe('Floor 2 Slice 5 — victory pipeline', () => {
  it('latches floor2-victory and pops stairs when all bosses die', () => {
    const seed = 97531;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;
    const families = loadFamilies();
    const resources = loadResources();
    const roster = selectFloor2Roster(new SeededRandom(seed), families, resources, {
      presentCountFourProbability: 0,
    });
    world.floor2State = {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    };
    const objectives = initializeFloor2Bosses(world, floorMap, world.floor2State);
    expect(objectives.length).toBeGreaterThan(0);

    const bossField = world.stores.familyMembership.isBoss;
    const familyIdxField = world.stores.familyMembership.familyId;
    for (const objective of objectives) {
      const presentIndex = world.floor2State.presentFamilies.indexOf(objective.familyId);
      let bossEid = -1;
      for (let eid = 0; eid < bossField.length; eid++) {
        if (bossField[eid] === 1 && familyIdxField[eid] === presentIndex) {
          bossEid = eid;
          break;
        }
      }
      expect(bossEid).toBeGreaterThan(0);
      world.combatEvents.push({
        type: 'death',
        x: 0,
        y: 0,
        amount: 999,
        targetType: 'enemy',
        timestamp: world.elapsedMs,
        targetEid: bossEid,
      } as (typeof world.combatEvents)[number]);
    }

    floor2ObjectiveTick(world);

    expect(world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID)).toBe(true);
    expect(world.goalFlags.get(FLOOR2_STAIRS_POPPED_GOAL_ID)).toBe(true);
    const floor2 = world.floor2State as {
      staircaseSpawned?: boolean;
      staircasePos?: { x: number; y: number };
    };
    expect(floor2.staircaseSpawned).toBe(true);
    expect(floor2.staircasePos).toBeDefined();
  });
});
