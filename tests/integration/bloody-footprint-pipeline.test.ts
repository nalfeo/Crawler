import { setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Health } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { runSimulationStep as runVisualStep } from '../../src/engine/sim/simulation-step.js';
import { runSimulationStep as runHeadlessStep } from '../../src/game/ai/simulation-step.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

const GREEN_BLOOD = 0x22aa44;

function runVisualFrame(world: ReturnType<typeof createTestWorld>): void {
  world.frameCount += 1;
  world.elapsedMs += GAME.DELTA_MS;
  runVisualStep(world, createInputState());
}

function summarizeWithVisualPipeline() {
  const world = createTestWorld({ seed: 13 });
  const playerEid = spawnPlayer(world, 0, 0);
  const enemyEid = spawnEnemy(world, 0, 0, 10, 120, GREEN_BLOOD);
  setComponent(world.ecs, enemyEid, Health, { current: 0, max: 10 });

  runVisualFrame(world);
  world.stores.position.x[playerEid] = 1.25;
  runVisualFrame(world);

  return {
    poolCount: world.bloodPools.length,
    sourceColor: world.bloodyFootprintState.source?.color ?? null,
    footprintCount: world.bloodyFootprints.length,
    footprintColor: world.bloodyFootprints[0]?.color ?? null,
  };
}

function summarizeWithHeadlessPipeline() {
  const world = createTestWorld({ seed: 13 });
  const playerEid = spawnPlayer(world, 0, 0);
  const enemyEid = spawnEnemy(world, 0, 0, 10, 120, GREEN_BLOOD);
  setComponent(world.ecs, enemyEid, Health, { current: 0, max: 10 });

  runHeadlessStep(world, createInputState(), GAME.DELTA_MS);
  world.stores.position.x[playerEid] = 1.25;
  runHeadlessStep(world, createInputState(), GAME.DELTA_MS);

  return {
    poolCount: world.bloodPools.length,
    sourceColor: world.bloodyFootprintState.source?.color ?? null,
    footprintCount: world.bloodyFootprints.length,
    footprintColor: world.bloodyFootprints[0]?.color ?? null,
  };
}

describe('bloody footprints pipeline wiring', () => {
  it('runs in both visual and headless simulation wrappers', () => {
    const visual = summarizeWithVisualPipeline();
    const headless = summarizeWithHeadlessPipeline();

    expect(visual.poolCount).toBe(1);
    expect(visual.sourceColor).toBe(GREEN_BLOOD);
    expect(visual.footprintCount).toBeGreaterThan(0);
    expect(visual.footprintColor).toBe(GREEN_BLOOD);
    expect(visual).toEqual(headless);
  });
});
