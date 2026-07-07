/**
 * Floor 1 spawner-free config — integration guard.
 *
 * Floor 1 policy (config-driven): its static-spawner spawn table is empty
 * (`FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS` in floorScenario.ts), so scenario init
 * places NO Spawner entities on Floor 1. With no spawners present, `spawnerSystem`
 * — wired uniformly in both pipelines — is a natural no-op: no children are ever
 * emitted. This test guards both real pipelines so Floor 1 does not regress back
 * to placing or running spawners.
 *
 * This test drives the EXACT headless pipeline (`runSimulationStep` from
 * `src/game/ai/simulation-step.ts`) and the visual engine pipeline on a real
 * Floor 1 world and proves no Spawner entities exist and no spawner children are
 * emitted in either shipped pipeline.
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
 * spawn the player, initialize the Floor 1 scenario (which places no static
 * spawners on Floor 1), then pick the first starter weapon to transition to
 * `playing`.
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

describe('Floor 1 is spawner-free by config — headless AI pipeline', () => {
  it('places no static spawner structures during Floor 1 scenario init', () => {
    const world = createPlayingFloor1World(7);
    const spawners = query(world.ecs, [Spawner]);
    // Floor 1's static-spawner spawn table is empty (FLOOR_1_STATIC_SPAWNER_*
    // in floorScenario.ts) — no Spawner entities should be placed at all.
    expect(spawners.length).toBe(0);
    expect(totalSpawnedChildren(world)).toBe(0);
  });

  it('keeps Floor 1 spawner-free (no children) when the simulation pipeline runs', () => {
    const world = createPlayingFloor1World(7);
    const input = createInputState();

    // Run long enough that several passive pulses would have happened if any
    // spawner existed; with none present spawnerSystem is a no-op.
    for (let frame = 0; frame < 600; frame += 1) {
      runSimulationStep(world, input, GAME.DELTA_MS, {});
    }

    expect(query(world.ecs, [Spawner]).length).toBe(0);
    expect(totalSpawnedChildren(world)).toBe(0);
  });
});

describe('Floor 1 is spawner-free by config — visual (engine) game pipeline', () => {
  it('keeps Floor 1 spawner-free (no children) when real Floor 1 scene options drive the engine sim step', () => {
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

    expect(query(world.ecs, [Spawner]).length).toBe(0);
    expect(totalSpawnedChildren(world)).toBe(0);
  });
});
