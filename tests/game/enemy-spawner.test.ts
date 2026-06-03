import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Enemy } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { configureEnemySpawner, enemySpawnerSystem, type SpawnerConfig } from '../../src/game/enemySpawnerSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

function createSpawnerConfig(): SpawnerConfig {
  return {
    maxEnemies: 2,
    spawnIntervalMs: 0,
    enemyHp: 25,
    enemySpeed: 2,
  };
}

describe('enemySpawnerSystem', () => {
  it('spawns enemies up to the configured max count', () => {
    const world = createTestWorld();
    spawnPlayer(world, 160, 90);
    configureEnemySpawner(world, { width: 320, height: 180 });
    const config = createSpawnerConfig();

    enemySpawnerSystem(world, config);
    enemySpawnerSystem(world, config);
    enemySpawnerSystem(world, config);

    expect(query(world.ecs, [Enemy]).length).toBe(2);
  });

  it('gives spawned enemies velocity toward the player', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    configureEnemySpawner(world, { width: 200, height: 200 });

    enemySpawnerSystem(world, {
      maxEnemies: 1,
      spawnIntervalMs: 0,
      enemyHp: 20,
      enemySpeed: 1.5,
    });

    const enemy = query(world.ecs, [Enemy])[0];
    expect(enemy).toBeDefined();

    const deltaX = (world.stores.position.x[player] ?? 0) - (world.stores.position.x[enemy!] ?? 0);
    const deltaY = (world.stores.position.y[player] ?? 0) - (world.stores.position.y[enemy!] ?? 0);
    const distance = Math.hypot(deltaX, deltaY);

    expect(world.stores.velocity.x[enemy!]).toBeCloseTo((deltaX / distance) * 1.5, 5);
    expect(world.stores.velocity.y[enemy!]).toBeCloseTo((deltaY / distance) * 1.5, 5);
  });

  it('uses the seeded world rng for deterministic spawns', () => {
    const worldA = createTestWorld({ seed: 99 });
    const worldB = createTestWorld({ seed: 99 });
    const config = createSpawnerConfig();

    spawnPlayer(worldA, 160, 90);
    spawnPlayer(worldB, 160, 90);
    configureEnemySpawner(worldA, { width: 320, height: 180 });
    configureEnemySpawner(worldB, { width: 320, height: 180 });

    enemySpawnerSystem(worldA, config);
    enemySpawnerSystem(worldA, config);
    enemySpawnerSystem(worldB, config);
    enemySpawnerSystem(worldB, config);

    const enemiesA = Array.from(query(worldA.ecs, [Enemy]));
    const enemiesB = Array.from(query(worldB.ecs, [Enemy]));

    expect(enemiesA).toHaveLength(2);
    expect(enemiesB).toHaveLength(2);

    for (let index = 0; index < enemiesA.length; index += 1) {
      const enemyA = enemiesA[index];
      const enemyB = enemiesB[index];

      expect(enemyA).toBeDefined();
      expect(enemyB).toBeDefined();

      if (enemyA === undefined || enemyB === undefined) {
        throw new Error('Expected deterministic enemy entities in both worlds.');
      }

      expect(worldA.stores.position.x[enemyA]).toBeCloseTo(worldB.stores.position.x[enemyB] ?? 0, 5);
      expect(worldA.stores.position.y[enemyA]).toBeCloseTo(worldB.stores.position.y[enemyB] ?? 0, 5);
    }
  });
});
