import { addComponent, entityExists, removeComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Bouncing, Velocity } from '../../src/core/components.js';
import { spawnBouncingProjectile, spawnProjectile } from '../../src/core/helpers.js';
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

  it('bounces bouncing projectiles off arena bounds and decrements remaining bounces', () => {
    const world = createTestWorld();
    const bouncing = spawnBouncingProjectile(world, -5, 360, -4, 0, 10, 2);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, bouncing)).toBe(true);
    expect(world.stores.bouncing.remainingBounces[bouncing]).toBe(1);
    expect(world.stores.velocity.x[bouncing]).toBe(4);
    expect(world.stores.position.x[bouncing]).toBe(0);
  });

  it('removes bouncing projectiles that leave play bounds with no bounces left', () => {
    const world = createTestWorld();
    const bouncing = spawnBouncingProjectile(world, -1, 360, -4, 0, 10, 0);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, bouncing)).toBe(false);
  });

  it('keeps non-bouncing projectiles using existing cleanup behavior', () => {
    const world = createTestWorld();
    const projectile = spawnProjectile(world, -1, 360, -4, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, projectile)).toBe(true);
  });

  it('supports entities flagged as bouncing even when velocity component is missing', () => {
    const world = createTestWorld();
    const bouncing = spawnProjectile(world, -5, 360, -4, 0, 10);
    // Simulate malformed data where bounce metadata exists but velocity tag was removed.
    world.stores.bouncing.remainingBounces[bouncing] = 1;
    addComponent(world.ecs, bouncing, Bouncing);
    removeComponent(world.ecs, bouncing, Velocity);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, bouncing)).toBe(true);
  });
});
