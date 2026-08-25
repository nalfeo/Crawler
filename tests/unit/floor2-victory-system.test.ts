import { describe, expect, it } from 'vitest';
import { removeEntity } from 'bitecs';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  FLOOR2_STAIRS_POPPED_GOAL_ID,
  FLOOR2_VICTORY_GOAL_ID,
  bossDefeatGoalId,
  floor2VictorySystem,
  confirmFloor2StairDescend,
  denUnlockGoalId,
  initializeFloor2Bosses,
} from '../../src/game/floor2Scenario.js';
import { createBossChestId } from '../../src/game/boss-chest-resolver.js';
import {
  createAchievementCatalog,
  createAchievementCatalogRegistry,
  FLOOR1_ACHIEVEMENTS,
} from '../../src/shared/achievements.js';
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
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    initializeFactionRelations(world, world.floorExtendedState!.familyState!.presentFamilies);
    const [survivor, ...others] = world.floorExtendedState!.familyState!.presentFamilies!;
    for (const familyId of others) {
      world.floorExtendedState!.familyState!.decapitatedFamilies ??= new Set();
      world.floorExtendedState!.familyState!.decapitatedFamilies!.add(familyId);
    }
    world.factionRelations.set(survivor!, 80);

    floor2VictorySystem(world);

    expect(world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID)).toBe(true);
    expect(world.goalFlags.get(FLOOR2_STAIRS_POPPED_GOAL_ID)).toBe(true);
    expect(world.floorExtendedState?.familyState?.staircaseSpawned).toBe(true);
    expect(world.floorExtendedState?.familyState?.staircaseUnlocked).toBe(true);
    expect(world.floorExtendedState?.familyState?.staircasePos).toBeDefined();
  });

  it('does not trigger Win A when relation is 75', () => {
    const seed = 1202;
    const world = createTestWorld({ seed, floor: 2 });
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources(), {
      presentCountFourProbability: 0,
    });
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    initializeFactionRelations(world, world.floorExtendedState!.familyState!.presentFamilies);
    const [survivor, ...others] = world.floorExtendedState!.familyState!.presentFamilies!;
    for (const familyId of others) {
      world.floorExtendedState!.familyState!.decapitatedFamilies ??= new Set();
      world.floorExtendedState!.familyState!.decapitatedFamilies!.add(familyId);
    }
    world.factionRelations.set(survivor!, 75);

    floor2VictorySystem(world);

    expect(world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID)).not.toBe(true);
  });

  it('does not trigger Win A when two or more families are still alive and friendly (FR15 exclusivity)', () => {
    const seed = 1204;
    const world = createTestWorld({ seed, floor: 2 });
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources(), {
      presentCountFourProbability: 0,
    });
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    initializeFactionRelations(world, world.floorExtendedState!.familyState!.presentFamilies);

    // Two or more families present, NONE decapitated (all alive), all friendly
    // (relation > 75). "Allying two families is not a win" (FR15), so Win A must
    // NOT latch — soleAliveFamily is null when aliveFamilies.length !== 1.
    expect(world.floorExtendedState!.familyState!.presentFamilies.length).toBeGreaterThanOrEqual(2);
    for (const familyId of world.floorExtendedState!.familyState!.presentFamilies) {
      world.factionRelations.set(familyId, 80);
    }

    floor2VictorySystem(world);

    expect(world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID)).not.toBe(true);
    expect(world.goalFlags.get(FLOOR2_STAIRS_POPPED_GOAL_ID)).not.toBe(true);
  });

  it('latches floor2-victory for Win B (all bosses dead)', () => {
    const seed = 1203;
    const world = createTestWorld({ seed, floor: 2 });
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources(), {
      presentCountFourProbability: 0,
    });
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    (
      world.floorExtendedState!.familyState as { decapitatedFamilies?: Set<string> }
    ).decapitatedFamilies = new Set(world.floorExtendedState!.familyState!.presentFamilies);

    floor2VictorySystem(world);

    expect(world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID)).toBe(true);
  });

  it('reconciles vanished boss encounters on the direct floor2VictorySystem path', () => {
    // Regression test for a gap surfaced by code review: a family whose boss
    // ECS entity vanishes without a normal `death` combat event (e.g. all
    // dens unlocked while the boss entity is otherwise despawned/recycled)
    // is latched "defeated" by this secondary sweep. Without a
    // spawnBossChestForDefeatedBoss call in that branch, such a family would
    // be permanently defeated with no boss chest ever created.
    const seed = 1205;
    const world = createTestWorld({
      seed,
      floor: 2,
      generatedEquipmentRunKey: 'victory-sweep-test',
    });
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    world.floorMap = floorMap;
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources(), {
      presentCountFourProbability: 0,
    });
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [...roster.presentFamilies],
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const floor2State = world.floorExtendedState.familyState!;
    initializeFloor2Bosses(world, floorMap, floor2State);
    const firstFamilyId = floor2State.presentFamilies[0]!;
    const firstEncounter = floor2State.bossEncounters!.get(firstFamilyId)!;
    const secondFamilyId = floor2State.presentFamilies[1]!;
    const secondEncounter = floor2State.bossEncounters!.get(secondFamilyId)!;
    expect(firstEncounter.started).toBe(false);
    secondEncounter.started = true;
    world.goalFlags.set(secondEncounter.activeGoalId, true);
    // No families decapitated yet, no living boss entities left in ECS (so
    // allBossesDead=false, allBossEntitiesGone=true), and every present family's
    // den goal flag is unlocked.
    for (const encounter of floor2State.bossEncounters!.values()) {
      if (encounter.bossEid !== null) {
        removeEntity(world.ecs, encounter.bossEid);
      }
    }
    for (const familyId of world.floorExtendedState.familyState!.presentFamilies) {
      world.goalFlags.set(denUnlockGoalId(familyId), true);
    }

    floor2VictorySystem(world);

    for (const familyId of world.floorExtendedState.familyState!.presentFamilies) {
      const chestId = createBossChestId(familyId);
      expect(world.bossChests.has(chestId)).toBe(true);
      expect(world.bossChests.get(chestId)?.state).toBe('available');
      expect(world.goalFlags.get(bossDefeatGoalId(familyId))).toBe(true);
    }
    expect(firstEncounter.defeated).toBe(true);
    expect(firstEncounter.bossEid).toBeNull();
    expect(world.goalFlags.get(firstEncounter.activeGoalId)).toBe(false);
    expect(firstEncounter.started).toBe(false);
    expect(secondEncounter.started).toBe(true);
    expect(world.goalFlags.get(secondEncounter.activeGoalId)).toBe(false);
  });
});

describe('confirmFloor2StairDescend', () => {
  function makeFloor2World(
    overrides?: Partial<import('../../src/core/faction-relations.js').Floor2State>,
  ) {
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [],
        contestedResource: 'glimmercap' as import('../../src/core/faction-relations.js').ResourceId,
        betrayerFlag: false,
        ...overrides,
      },
    };
    world.state = 'playing';
    return world;
  }

  it('returns false when floor2State is null', () => {
    const world = createTestWorld({ seed: 42 });
    expect(confirmFloor2StairDescend(world, 0)).toBe(false);
  });

  it('returns false when world.state is not playing', () => {
    const world = makeFloor2World({ staircaseSpawned: true, staircaseUnlocked: true });
    world.state = 'game_over';
    expect(confirmFloor2StairDescend(world, 0)).toBe(false);
  });

  it('returns false when staircase has not been spawned', () => {
    const world = makeFloor2World({ staircaseSpawned: false });
    expect(confirmFloor2StairDescend(world, 0)).toBe(false);
  });

  it('returns false when staircase is not unlocked', () => {
    const world = makeFloor2World({ staircaseSpawned: true, staircaseUnlocked: false });
    expect(confirmFloor2StairDescend(world, 0)).toBe(false);
  });

  it('returns false when staircase already discovered', () => {
    const world = makeFloor2World({
      staircaseSpawned: true,
      staircaseUnlocked: true,
      staircaseDiscovered: true,
    });
    expect(confirmFloor2StairDescend(world, 0)).toBe(false);
  });

  it('sets staircaseDiscovered and transitions to safe_room', () => {
    const world = makeFloor2World({ staircaseSpawned: true, staircaseUnlocked: true });
    const result = confirmFloor2StairDescend(world, 0);
    expect(result).toBe(true);
    expect(world.floorExtendedState?.familyState?.staircaseDiscovered).toBe(true);
    expect(world.state).toBe('safe_room');
  });

  it('evaluates Floor 2 run-end achievements before transitioning to the safe room', () => {
    const world = makeFloor2World({ staircaseSpawned: true, staircaseUnlocked: true });
    const registry = createAchievementCatalogRegistry([
      createAchievementCatalog(2, [
        {
          ...FLOOR1_ACHIEVEMENTS[0],
          id: 'floor2-clear-test',
          floor: 2,
          scope: 'current_run',
          unlockRules: [
            {
              type: 'booleanIs',
              fact: 'runClearedFloor',
              value: true,
              phase: 'run_end_clear',
            },
          ],
        },
      ]),
    ]);

    expect(confirmFloor2StairDescend(world, 0, registry)).toBe(true);
    expect(world.achievements.unlockedIds.has('floor2-clear-test')).toBe(true);
  });

  it('is idempotent — second call returns false after staircase discovered', () => {
    const world = makeFloor2World({ staircaseSpawned: true, staircaseUnlocked: true });
    confirmFloor2StairDescend(world, 0);
    // state is now 'safe_room', not 'playing' — second call must fail
    expect(confirmFloor2StairDescend(world, 0)).toBe(false);
  });
});
