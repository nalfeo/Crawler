import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  FLOOR2_STAIRS_POPPED_GOAL_ID,
  FLOOR2_VICTORY_GOAL_ID,
  floor2VictorySystem,
} from '../../src/game/floor2Scenario.js';
import {
  initializeFactionRelations,
  selectFloor2Roster,
} from '../../src/core/faction-relations.js';
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

describe('floor2VictorySystem', () => {
  it('latches floor2-victory for Win A (sole alive ally relation > 75)', () => {
    const seed = 1201;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;

    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources(), {
      presentCountFourProbability: 0,
    });
    world.floor2State = {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    };
    initializeFactionRelations(world, world.floor2State.presentFamilies);
    const [survivor, ...others] = world.floor2State.presentFamilies;
    for (const familyId of others) {
      (world.floor2State as { decapitatedFamilies?: Set<string> }).decapitatedFamilies ??=
        new Set<string>();
      (world.floor2State as { decapitatedFamilies?: Set<string> }).decapitatedFamilies!.add(
        familyId,
      );
    }
    world.factionRelations.set(survivor!, 80);

    floor2VictorySystem(world);

    expect(world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID)).toBe(true);
    expect(world.goalFlags.get(FLOOR2_STAIRS_POPPED_GOAL_ID)).toBe(true);
    const floor2 = world.floor2State as {
      staircasePos?: { x: number; y: number };
      staircaseSpawned?: boolean;
      staircaseUnlocked?: boolean;
    };
    expect(floor2.staircaseSpawned).toBe(true);
    expect(floor2.staircaseUnlocked).toBe(true);
    expect(floor2.staircasePos).toBeDefined();
  });

  it('does not trigger Win A when relation is 75', () => {
    const seed = 1202;
    const world = createTestWorld({ seed, floor: 2 });
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources(), {
      presentCountFourProbability: 0,
    });
    world.floor2State = {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    };
    initializeFactionRelations(world, world.floor2State.presentFamilies);
    const [survivor, ...others] = world.floor2State.presentFamilies;
    for (const familyId of others) {
      (world.floor2State as { decapitatedFamilies?: Set<string> }).decapitatedFamilies ??=
        new Set<string>();
      (world.floor2State as { decapitatedFamilies?: Set<string> }).decapitatedFamilies!.add(
        familyId,
      );
    }
    world.factionRelations.set(survivor!, 75);

    floor2VictorySystem(world);

    expect(world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID)).not.toBe(true);
  });

  it('latches floor2-victory for Win B (all bosses dead)', () => {
    const seed = 1203;
    const world = createTestWorld({ seed, floor: 2 });
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources(), {
      presentCountFourProbability: 0,
    });
    world.floor2State = {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    };
    (world.floor2State as { decapitatedFamilies?: Set<string> }).decapitatedFamilies = new Set(
      world.floor2State.presentFamilies,
    );

    floor2VictorySystem(world);

    expect(world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID)).toBe(true);
  });
});
