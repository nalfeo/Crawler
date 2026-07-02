import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import type { GameWorld } from '../../src/core/index.js';
import { runSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Unit coverage for {@link runSimulationStep} — the ordered ECS pipeline lifted
 * verbatim out of `MainGameScene.update()`. The headless Floor-1 win-rate gate
 * is the behavioral proof that the pipeline itself is unchanged; these tests pin
 * the extracted module's hook contract (pre/after/post seams) directly so the
 * decomposition's interleaving is provably faithful and stays that way.
 */

/** A test world with a fully-initialized Floor 1 scenario (real, steppable). */
function freshFloor1World(): GameWorld {
  const world = createTestWorld();
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  return world;
}

describe('runSimulationStep', () => {
  it('runs a full step on a real Floor 1 world without throwing', () => {
    const world = freshFloor1World();
    expect(() => runSimulationStep(world, createInputState())).not.toThrow();
  });

  it('tolerates being called with no hooks', () => {
    const world = freshFloor1World();
    expect(() => runSimulationStep(world, createInputState(), {})).not.toThrow();
  });

  it('runs preSystems then the afterInput seam then postSystems, in that order', () => {
    const world = freshFloor1World();
    const order: string[] = [];

    runSimulationStep(world, createInputState(), {
      preSystems: [() => order.push('pre1'), () => order.push('pre2')],
      afterInput: () => order.push('afterInput'),
      postSystems: [() => order.push('post1'), () => order.push('post2')],
    });

    expect(order).toEqual(['pre1', 'pre2', 'afterInput', 'post1', 'post2']);
  });

  it('fires the afterInput seam exactly once per step', () => {
    const world = freshFloor1World();
    let afterInputCalls = 0;

    runSimulationStep(world, createInputState(), {
      afterInput: () => {
        afterInputCalls += 1;
      },
    });

    expect(afterInputCalls).toBe(1);
  });

  it('passes the same world instance to pre- and post-systems', () => {
    const world = freshFloor1World();
    const seen: GameWorld[] = [];

    runSimulationStep(world, createInputState(), {
      preSystems: [(w) => seen.push(w)],
      postSystems: [(w) => seen.push(w)],
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(world);
    expect(seen[1]).toBe(world);
  });

  it('invokes an injected runFovSystem override exactly once with the world', () => {
    const world = freshFloor1World();
    const calls: GameWorld[] = [];

    runSimulationStep(world, createInputState(), {
      runFovSystem: (w) => calls.push(w),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(world);
  });

  it('runs the built-in fovSystem when no override is supplied (FOV still computed)', () => {
    const world = freshFloor1World();
    const floorMap = world.floorMap;
    expect(floorMap).not.toBeNull();
    // Wipe visibility so any lit cell afterward must come from this step's FOV.
    floorMap!.clearVisibility();
    expect(floorMap!.visible.some((v) => v !== 0)).toBe(false);

    // With no runFovSystem hook, the default fovSystem must run and light cells.
    runSimulationStep(world, createInputState());

    expect(floorMap!.visible.some((v) => v !== 0)).toBe(true);
  });
});
