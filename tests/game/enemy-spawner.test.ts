import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Enemy } from '../../src/core/components.js';
import { spawnBehaviorEnemy, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import {
  configureEnemySpawner,
  enemySpawnerSystem,
  type SpawnerConfig,
} from '../../src/game/enemySpawnerSystem.js';
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

      expect(worldA.stores.position.x[enemyA]).toBeCloseTo(
        worldB.stores.position.x[enemyB] ?? 0,
        5,
      );
      expect(worldA.stores.position.y[enemyA]).toBeCloseTo(
        worldB.stores.position.y[enemyB] ?? 0,
        5,
      );
    }
  });

  it('does nothing when no player exists', () => {
    const world = createTestWorld();
    configureEnemySpawner(world, { width: 320, height: 180 });

    enemySpawnerSystem(world, createSpawnerConfig());

    expect(query(world.ecs, [Enemy])).toHaveLength(0);
  });

  it('skips steering enemies that use EnemyBehavior', () => {
    const world = createTestWorld();
    spawnPlayer(world, 160, 90);
    const behaviorEnemy = spawnBehaviorEnemy(world, 10, 20, 20, AI_TYPE.CHASE, 2, 100, 0);
    world.stores.velocity.x[behaviorEnemy] = 0.25;
    world.stores.velocity.y[behaviorEnemy] = -0.75;

    enemySpawnerSystem(world, {
      maxEnemies: 3,
      spawnIntervalMs: 0,
      enemyHp: 20,
      enemySpeed: 1,
    });

    expect(world.stores.velocity.x[behaviorEnemy]).toBeCloseTo(0.25);
    expect(world.stores.velocity.y[behaviorEnemy]).toBeCloseTo(-0.75);
  });

  it('enforces spawn interval timing', () => {
    const world = createTestWorld();
    spawnPlayer(world, 160, 90);
    configureEnemySpawner(world, { width: 320, height: 180 });
    const config: SpawnerConfig = {
      maxEnemies: 3,
      spawnIntervalMs: 100,
      enemyHp: 25,
      enemySpeed: 2,
    };

    world.elapsedMs = 1000;
    enemySpawnerSystem(world, config);
    world.elapsedMs = 1050;
    enemySpawnerSystem(world, config);
    world.elapsedMs = 1200;
    enemySpawnerSystem(world, config);

    expect(query(world.ecs, [Enemy])).toHaveLength(2);
  });

  it('sets velocity to zero when an enemy is exactly on top of the player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 32, 48);
    const enemy = spawnEnemy(world, 32, 48, 20);

    enemySpawnerSystem(world, {
      maxEnemies: 1,
      spawnIntervalMs: 0,
      enemyHp: 20,
      enemySpeed: 3,
    });

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('separates overlapping simple enemies spawned at the exact same position', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const a = spawnEnemy(world, 32, 32, 20);
    const b = spawnEnemy(world, 32, 32, 20);

    enemySpawnerSystem(world, {
      maxEnemies: 10,
      spawnIntervalMs: Number.POSITIVE_INFINITY,
      enemyHp: 20,
      enemySpeed: 1,
    });

    expect(
      Math.hypot(world.stores.velocity.x[a] ?? 0, world.stores.velocity.y[a] ?? 0),
    ).toBeGreaterThan(0);
    expect(
      Math.hypot(world.stores.velocity.x[b] ?? 0, world.stores.velocity.y[b] ?? 0),
    ).toBeGreaterThan(0);
    expect(
      Math.hypot(world.stores.velocity.x[a] ?? 0, world.stores.velocity.y[a] ?? 0),
    ).toBeLessThanOrEqual(1.00001);
    expect(
      Math.hypot(world.stores.velocity.x[b] ?? 0, world.stores.velocity.y[b] ?? 0),
    ).toBeLessThanOrEqual(1.00001);
  });

  it('applies separation force for near-overlap (non-zero distance) and keeps speed capped', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const a = spawnEnemy(world, 20, 20, 20);
    const b = spawnEnemy(world, 24, 20, 20);

    enemySpawnerSystem(world, {
      maxEnemies: 10,
      spawnIntervalMs: Number.POSITIVE_INFINITY,
      enemyHp: 20,
      enemySpeed: 0.5,
    });

    const aMag = Math.hypot(world.stores.velocity.x[a] ?? 0, world.stores.velocity.y[a] ?? 0);
    const bMag = Math.hypot(world.stores.velocity.x[b] ?? 0, world.stores.velocity.y[b] ?? 0);
    expect(aMag).toBeGreaterThan(0);
    expect(bMag).toBeGreaterThan(0);
    expect(aMag).toBeLessThanOrEqual(0.50001);
    expect(bMag).toBeLessThanOrEqual(0.50001);
  });
});
