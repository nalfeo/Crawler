/**
 * Floor 1 spawner wiring — integration guard.
 *
 * Floor 1 temporary policy: keep static spawner structures in the map, but do not
 * run `spawnerSystem` while it is broken. This test guards both real pipelines so
 * Floor 1 does not regress back to active spawning before the system is fixed.
 *
 * This test drives the EXACT headless pipeline (`runSimulationStep` from
 * `src/game/ai/simulation-step.ts`) on a real Floor 1 world and proves no spawner
 * children are emitted in either shipped pipeline.
 *
 * Determinism: fixed seed, `SeededRandom`-backed world, fixed `GAME.DELTA_MS`
 * steps, empty input — no `Math.random` / `Date.now`.
 */
import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Spawner, createGameWorld, spawnPlayer, type GameWorld } from '../../src/core/index.js';
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

describe('Floor 1 spawners — disabled in the headless AI pipeline', () => {
  it('places static spawner structures during Floor 1 scenario init', () => {
    const world = createPlayingFloor1World(7);
    const spawners = query(world.ecs, [Spawner]);
    // Floor 1 seeds 2 archetypes × 2 each (see FLOOR_1_STATIC_SPAWNER_* in
    // floorScenario.ts) — assert the structures exist before we simulate.
    expect(spawners.length).toBeGreaterThanOrEqual(1);
    // Nothing has run yet, so no children should have been emitted.
    expect(totalSpawnedChildren(world)).toBe(0);
  });

  it('does not emit spawner children when the simulation pipeline runs', () => {
    const world = createPlayingFloor1World(7);
    const input = createInputState();

    // Run long enough that several passive pulses would have happened if
    // spawnerSystem were enabled.
    for (let frame = 0; frame < 600; frame += 1) {
      runSimulationStep(world, input, GAME.DELTA_MS, {});
    }

    expect(totalSpawnedChildren(world)).toBe(0);
  });
});

describe('Floor 1 spawners — disabled in the visual (engine) game pipeline', () => {
  it('does not emit spawner children when real Floor 1 scene options drive the engine sim step', () => {
    const world = createPlayingFloor1World(7);
    const input = createInputState();
    const options = createFloor1MainSceneOptions();

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

    expect(totalSpawnedChildren(world)).toBe(0);
  });
});
