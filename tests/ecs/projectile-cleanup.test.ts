import { entityExists } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnProjectile } from '../../src/core/helpers.js';
import { projectileCleanupSystem } from '../../src/core/systems/projectileCleanupSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('projectileCleanupSystem', () => {
  it('removes projectiles that leave game bounds', () => {
    const world = createTestWorld();
    const offscreenRight = spawnProjectile(world, 1500, 360, 5, 0, 10);
    const offscreenTop = spawnProjectile(world, 640, -200, 0, -5, 10);
    const inBounds = spawnProjectile(world, 640, 360, 5, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, offscreenRight)).toBe(false);
    expect(entityExists(world.ecs, offscreenTop)).toBe(false);
    expect(entityExists(world.ecs, inBounds)).toBe(true);
  });

  it('keeps projectiles within the cull margin', () => {
    const world = createTestWorld();
    // Just barely inside margin (GAME.WIDTH + 100 = 1380 is the boundary)
    const nearEdge = spawnProjectile(world, 1370, 360, 5, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, nearEdge)).toBe(true);
  });
});
