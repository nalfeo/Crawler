import { setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { EnemyBehavior, Velocity } from '../../src/core/components.js';
import {
  movementSystem,
  spawnBehaviorEnemy,
  spawnEnemy,
  spawnPlayer,
} from '../../src/core/index.js';
import { AI_TYPE, enemyAISystem } from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('enemyAISystem', () => {
  it('moves a chase enemy toward the player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 10, 0, 20, AI_TYPE.CHASE, 2, 100, 0);

    enemyAISystem(world);
    movementSystem(world);

    expect(world.stores.position.x[enemy]).toBeLessThan(10);
    expect(world.stores.position.y[enemy]).toBeCloseTo(0);
  });

  it('sets chase enemy velocity toward the player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 3, 4, 20, AI_TYPE.CHASE, 2.5, 100, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(-1.5);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(-2);
  });

  it('moves a swarm enemy toward the player while separating from nearby swarmers', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 0);
    const swarmer = spawnBehaviorEnemy(world, 0, 0, 20, AI_TYPE.SWARM, 2, 200, 0);
    spawnBehaviorEnemy(world, 0, 10, 20, AI_TYPE.SWARM, 2, 200, 0);

    enemyAISystem(world);

    expect(world.stores.velocity.x[swarmer]).toBeGreaterThan(0);
    expect(world.stores.velocity.y[swarmer]).toBeLessThan(0);
  });

  it('makes ranged enemies back away when they are too close', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 50, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeGreaterThan(0);
    expect(world.stores.velocity.y[enemy]).toBeCloseTo(0);
  });

  it('stops ranged enemies from approaching once they are within attack range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 140, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);

    expect(world.stores.velocity.x[enemy]).toBeCloseTo(0);
    expect(Math.abs(world.stores.velocity.y[enemy] ?? 0)).toBeCloseTo(1.5);
  });

  it('affects only enemies with the EnemyBehavior component', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const plainEnemy = spawnEnemy(world, 50, 0, 20);

    setComponent(world.ecs, plainEnemy, Velocity, { x: 0.75, y: -0.25 });
    enemyAISystem(world);

    expect(world.stores.velocity.x[plainEnemy]).toBeCloseTo(0.75);
    expect(world.stores.velocity.y[plainEnemy]).toBeCloseTo(-0.25);
    expect(world.stores.enemyBehavior.type[plainEnemy]).toBe(0);
    expect(EnemyBehavior).toBeTypeOf('object');
  });
});
