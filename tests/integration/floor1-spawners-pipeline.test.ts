/**
 * Floor 1 spawner wiring — integration guard.
 *
 * The spawner feature (Rats Nest / Slime Pool structures that periodically emit
 * mobs, enrage when hit, and burst a finale on death) was built and lab-proven
 * (`src/labs/spawner-lab/`) but the `spawnerSystem` was never wired into either
 * real fixed-timestep pipeline — the headless AI runner
 * (`src/game/ai/simulation-step.ts`) or the visual game
 * (`src/bootstrap/floor-main-scene-options.ts` preSystems). So Floor 1 placed
 * spawner structures that just sat there: they never spawned a single child in
 * the actual game.
 *
 * This test drives the EXACT headless pipeline (`runSimulationStep` from
 * `src/game/ai/simulation-step.ts`) on a real Floor 1 world and proves the
 * spawners now actually spawn — closing the wiring gap deterministically so a
 * future refactor that drops `spawnerSystem` from the pipeline fails here rather
 * than silently shipping dead structures again.
 *
 * Determinism: fixed seed, `SeededRandom`-backed world, fixed `GAME.DELTA_MS`
 * steps, empty input — no `Math.random` / `Date.now`.
 */
import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Enemy,
  Spawner,
  createGameWorld,
  spawnPlayer,
  type GameWorld,
} from '../../src/core/index.js';
import { initializeFloor1Scenario, selectFloor1StarterWeapon } from '../../src/game/index.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { runSimulationStep as runVisualSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';

/**
 * Stand up a real Floor 1 world exactly the way the headless runner does
 * (`runHeadless` in `src/game/ai/headless-runner.ts`): create a seeded world,
 * spawn the player, initialize the Floor 1 scenario (which places the static
 * spawners), then pick the first starter weapon to transition to `playing`.
 */
function createPlayingFloor1World(seed: number): GameWorld {
  const world = createGameWorld({ seed });
  const playerEid = spawnPlayer(world, 400, 400);
  initializeFloor1Scenario(world, playerEid);
  selectFloor1StarterWeapon(world, 0);
  return world;
}

/** Sum of children emitted so far across every live spawner structure. */
function totalSpawnedChildren(world: GameWorld): number {
  const spawners = query(world.ecs, [Spawner]);
  let total = 0;
  for (const eid of spawners) {
    if (eid === undefined) continue;
    total += world.stores.spawner.spawnedTotal[eid] ?? 0;
  }
  return total;
}

describe('Floor 1 spawners — wired into the headless AI pipeline', () => {
  it('places static spawner structures during Floor 1 scenario init', () => {
    const world = createPlayingFloor1World(7);
    const spawners = query(world.ecs, [Spawner]);
    // Floor 1 seeds 2 archetypes × 2 each (see FLOOR_1_STATIC_SPAWNER_* in
    // floorScenario.ts) — assert the structures exist before we simulate.
    expect(spawners.length).toBeGreaterThanOrEqual(1);
    // Nothing has run yet, so no children should have been emitted.
    expect(totalSpawnedChildren(world)).toBe(0);
  });

  it('emits spawner children once the simulation pipeline runs', () => {
    const world = createPlayingFloor1World(7);
    const input = createInputState();

    const enemiesBefore = query(world.ecs, [Enemy]).length;

    // Each spawner is eligible from frame 1 (initialDelayMs 0), and 10 game-
    // seconds (600 × DELTA_MS) clears even the slowest passive interval
    // (Slime Pool 4200ms) several times over, so passive pulses must have fired
    // if the system is wired in. Without the wiring this loop leaves
    // spawnedTotal at 0.
    for (let frame = 0; frame < 600; frame += 1) {
      runSimulationStep(world, input, GAME.DELTA_MS, {});
    }

    // The load-bearing assertion: spawners actually spawned. This is 0 unless
    // `spawnerSystem` runs inside `runSimulationStep`.
    expect(totalSpawnedChildren(world)).toBeGreaterThan(0);

    // And those children are real, live enemies in the world — the structures
    // (also tagged Enemy) plus at least one emitted child exceed the start count.
    const enemiesAfter = query(world.ecs, [Enemy]).length;
    expect(enemiesAfter).toBeGreaterThan(enemiesBefore);
  });
});

describe('Floor 1 spawners — wired into the visual (engine) game pipeline', () => {
  it('emits spawner children when the real Floor 1 scene options drive the engine sim step', () => {
    // This drives the SHIPPED VISUAL pipeline end-to-end: the engine
    // `runSimulationStep` (`src/engine/sim/simulation-step.ts`, the exact function
    // `MainGameScene.update()` calls) fed with the REAL
    // `createFloor1MainSceneOptions().preSystems/postSystems`. The original bug
    // shipped precisely because the feature "worked in the spawner lab" but was
    // never exercised in this path — and an order-only assertion on `preSystems`
    // cannot catch a regression where the array stops actually executing
    // `spawnerSystem`. This proves the browser game path spawns, deterministically
    // (fixed seed, `SeededRandom`, fixed `GAME.DELTA_MS`, empty input).
    const world = createPlayingFloor1World(7);
    const input = createInputState();
    const options = createFloor1MainSceneOptions();

    const enemiesBefore = query(world.ecs, [Enemy]).length;

    // Mirror MainGameScene's fixed-timestep loop exactly: it advances
    // frameCount/elapsedMs ITSELF (MainGameScene.update, before calling the engine
    // step) because — unlike the headless `game/ai` step — the engine
    // `runSimulationStep` does not advance time internally.
    for (let frame = 0; frame < 600; frame += 1) {
      world.frameCount += 1;
      world.elapsedMs += GAME.DELTA_MS;
      runVisualSimulationStep(world, input, {
        preSystems: options.preSystems,
        postSystems: options.postSystems,
      });
    }

    // Load-bearing: the shipped visual pipeline actually emitted spawner children.
    expect(totalSpawnedChildren(world)).toBeGreaterThan(0);
    const enemiesAfter = query(world.ecs, [Enemy]).length;
    expect(enemiesAfter).toBeGreaterThan(enemiesBefore);
  });
});
