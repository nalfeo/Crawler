import { query } from 'bitecs';
import { describe, expect, it, vi } from 'vitest';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  EnemyProjectile,
  Position,
  spawnBehaviorEnemy,
  spawnPlayer,
  type GameWorld,
} from '../../src/core/index.js';
import { AI_TYPE } from '../../src/game/index.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';

interface ObservedProjectile {
  readonly x: number;
  readonly y: number;
}

function runStepWithOriginObserver(
  world: GameWorld,
  observe: (projectile: ObservedProjectile) => void,
): void {
  const { preSystems } = createFloor1MainSceneOptions();
  runSimulationStep(world, createInputState(), 16, {
    preSystems: [
      ...preSystems,
      (pipelineWorld: GameWorld) => {
        const projectile = query(pipelineWorld.ecs, [EnemyProjectile, Position])[0];
        if (projectile === undefined) return;
        observe({
          x: pipelineWorld.stores.position.x[projectile]!,
          y: pipelineWorld.stores.position.y[projectile]!,
        });
      },
    ],
  });
}

describe('enemy projectile origin in the real headless pipeline', () => {
  it('spawns immediate fire at the current shooter pivot before movement', () => {
    const world = createTestWorld();
    world.state = 'playing';
    world.elapsedMs = 100;
    world.enemyTelegraphMs = 0;
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);
    const shooterPivot = {
      x: world.stores.position.x[enemy]!,
      y: world.stores.position.y[enemy]!,
    };
    let observed: ObservedProjectile | undefined;

    runStepWithOriginObserver(world, (projectile) => {
      observed = projectile;
    });

    expect(observed).toEqual(shooterPivot);
  });

  it('spawns delayed fire at its locked pivot after the shooter moves', () => {
    const world = createTestWorld();
    world.state = 'playing';
    world.elapsedMs = 100;
    world.enemyTelegraphMs = 250;
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);
    const lockedPivot = {
      x: world.stores.position.x[enemy]!,
      y: world.stores.position.y[enemy]!,
    };
    let observed: ObservedProjectile | undefined;

    runStepWithOriginObserver(world, (projectile) => {
      observed = projectile;
    });
    expect(observed).toBeUndefined();

    world.stores.position.x[enemy] = 140;
    world.stores.position.y[enemy] = 20;
    world.elapsedMs = 500;
    runStepWithOriginObserver(world, (projectile) => {
      observed = projectile;
    });

    expect(observed).toEqual(lockedPivot);
  });
});
