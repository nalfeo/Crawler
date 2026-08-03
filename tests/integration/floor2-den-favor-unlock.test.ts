import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  initializeFloor2Bosses,
  floor2ObjectiveTick,
  isDenUnlocked,
  hasEarnedDenFavor,
  denFavorGoalId,
} from '../../src/game/floor2Scenario.js';
import { adjustFactionRelation, selectFloor2Roster } from '../../src/core/faction-relations.js';
import type { FamilyId } from '../../src/core/faction-relations.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import { floorObjectiveSystem } from '../../src/game/floorScenario.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import type { GameWorld } from '../../src/core/index.js';

/**
 * FR13 `win-favor` — the peaceful den-unlock route. Reaching the Friendly band
 * (>75) with a family opens its boss den in parallel with the kill-based
 * objective assigned at floor init.
 */

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

function setupFloor2(seed: number): {
  world: GameWorld;
  familyIds: readonly FamilyId[];
} {
  const gen = new CaveSystemGenerator({ presentCount: 3 });
  const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
  const world = createTestWorld({ seed, floor: 2 });
  world.state = 'playing';
  const roster = selectFloor2Roster(new SeededRandom(seed), loadFamilies(), loadResources());
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    },
  };
  const objectives = initializeFloor2Bosses(world, floorMap, world.floorExtendedState.familyState!);
  world.floorMap = floorMap;
  return { world, familyIds: objectives.map((o) => o.familyId) };
}

/** Raise a family to the Friendly band (>75) from whatever it currently is. */
function raiseToFriendly(world: GameWorld, familyId: FamilyId): void {
  adjustFactionRelation(world, familyId, 100);
}

describe('Floor 2 — favor den-unlock route (FR13 win-favor)', () => {
  it('reaching Friendly opens the den and its doors', () => {
    const { world, familyIds } = setupFloor2(4242);
    const target = familyIds[0]!;
    const encounter = world.floorExtendedState!.familyState!.bossEncounters!.get(target)!;

    expect(isDenUnlocked(world, target)).toBe(false);
    expect(world.goalFlags.get(denFavorGoalId(target))).toBe(false);
    expect(hasEarnedDenFavor(world, target)).toBe(false);

    raiseToFriendly(world, target);
    expect(hasEarnedDenFavor(world, target)).toBe(true);

    floor2ObjectiveTick(world);
    doorSystem(world);

    expect(world.goalFlags.get(denFavorGoalId(target))).toBe(true);
    expect(isDenUnlocked(world, target)).toBe(true);
    expect(encounter.doorEids.length).toBeGreaterThan(0);
    for (const doorEid of encounter.doorEids) {
      expect(world.stores.doorState.isLocked[doorEid]).toBe(0);
      expect(world.stores.doorState.logicalOpen[doorEid]).toBe(1);
    }
  });

  it('only the favored family is opened; others stay sealed', () => {
    const { world, familyIds } = setupFloor2(909);
    const target = familyIds[0]!;
    raiseToFriendly(world, target);
    floor2ObjectiveTick(world);

    expect(isDenUnlocked(world, target)).toBe(true);
    for (const other of familyIds.slice(1)) {
      expect(isDenUnlocked(world, other)).toBe(false);
      expect(world.goalFlags.get(denFavorGoalId(other))).toBe(false);
    }
  });

  it('a later relation drop does not re-seal a den earned by favor', () => {
    const { world, familyIds } = setupFloor2(31337);
    const target = familyIds[0]!;
    raiseToFriendly(world, target);
    floor2ObjectiveTick(world);
    expect(isDenUnlocked(world, target)).toBe(true);

    // Kill a few of their mobs afterwards — relation falls out of Friendly.
    adjustFactionRelation(world, target, -60);
    expect(hasEarnedDenFavor(world, target)).toBe(false);
    floor2ObjectiveTick(world);

    expect(world.goalFlags.get(denFavorGoalId(target))).toBe(true);
    expect(isDenUnlocked(world, target)).toBe(true);
  });

  it('stays locked while the reputation system is inactive', () => {
    const { world, familyIds } = setupFloor2(5150);
    const target = familyIds[0]!;
    world.floorExtendedState!.familyState!.reputationSystemActive = false;
    raiseToFriendly(world, target);

    expect(hasEarnedDenFavor(world, target)).toBe(false);
    floor2ObjectiveTick(world);
    expect(isDenUnlocked(world, target)).toBe(false);
  });

  it('neutral-band relation never opens the den', () => {
    const { world, familyIds } = setupFloor2(2024);
    const target = familyIds[0]!;
    // Default relation is 45; push to exactly the top of the neutral band (75).
    world.factionRelations.set(target, 75);
    expect(hasEarnedDenFavor(world, target)).toBe(false);
    floor2ObjectiveTick(world);
    expect(isDenUnlocked(world, target)).toBe(false);

    adjustFactionRelation(world, target, 1);
    expect(hasEarnedDenFavor(world, target)).toBe(true);
    floor2ObjectiveTick(world);
    expect(isDenUnlocked(world, target)).toBe(true);
  });
});

/**
 * Pipeline-level smoke test: the favor unlock flows through the real
 * floorObjectiveSystem → world.floorObjectiveTick dispatch used by both
 * shipped simulation-step pipelines. Unlike the direct-tick tests above, this
 * test proves the plumbing is wired: runSimulationStep with floorObjectiveSystem
 * in postSystems reaches floor2ObjectiveTick the same way the headless AI runner
 * and the visual game do.
 */
describe('Floor 2 — favor den-unlock via real simulation pipeline (FR13)', () => {
  it('floorObjectiveSystem dispatches the favor latch through runSimulationStep', () => {
    const { world, familyIds } = setupFloor2(8888);
    const target = familyIds[0]!;

    // Wire the floor objective tick the same way initializeFloor2Scenario does.
    world.floorObjectiveTick = floor2ObjectiveTick;

    expect(isDenUnlocked(world, target)).toBe(false);
    expect(world.goalFlags.get(denFavorGoalId(target))).toBe(false);

    // Raise to Friendly before the sim step.
    adjustFactionRelation(world, target, 100);
    expect(hasEarnedDenFavor(world, target)).toBe(true);

    // Drive through the real pipeline: floorObjectiveSystem calls
    // world.floorObjectiveTick?.(world), which calls floor2ObjectiveTick.
    // doorSystem is also in the core pipeline so door state is updated.
    runSimulationStep(world, createInputState(), GAME.DELTA_MS, {
      postSystems: [floorObjectiveSystem],
    });

    expect(world.goalFlags.get(denFavorGoalId(target))).toBe(true);
    expect(isDenUnlocked(world, target)).toBe(true);
  });
});
