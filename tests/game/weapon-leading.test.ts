import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Position, Projectile, Velocity } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import {
  computeLeadDirection,
  setActiveWeapon,
  weaponSystem,
} from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('computeLeadDirection', () => {
  it('aims directly at a stationary target', () => {
    const dir = computeLeadDirection(120, 0, 0, 0, 6);
    expect(dir.x).toBeCloseTo(1, 6);
    expect(dir.y).toBeCloseTo(0, 6);
  });

  it('normalizes the returned direction', () => {
    const dir = computeLeadDirection(80, 60, 1.5, -2, 6);
    expect(Math.hypot(dir.x, dir.y)).toBeCloseTo(1, 6);
  });

  it('leads a target crossing perpendicular so the projectile tracks its lateral motion', () => {
    // Target straight ahead (+x) moving purely along +y. For interception the
    // projectile's y-velocity component must equal the target's y-velocity:
    //   dir.y * projectileSpeed === targetVy
    const projectileSpeed = 6;
    const targetVy = 2;
    const dir = computeLeadDirection(120, 0, 0, targetVy, projectileSpeed);
    expect(dir.y * projectileSpeed).toBeCloseTo(targetVy, 5);
    expect(dir.x).toBeGreaterThan(0); // still travelling forward
  });

  it('reproduces an exact interception point', () => {
    const projectileSpeed = 6;
    const deltaX = 150;
    const deltaY = -40;
    const targetVx = 1;
    const targetVy = 3;
    const dir = computeLeadDirection(deltaX, deltaY, targetVx, targetVy, projectileSpeed);

    // Solve for the flight time implied by the x-axis, then confirm the y-axis
    // also lines up — i.e. projectile and target meet at the same point.
    const t = deltaX / (dir.x * projectileSpeed - targetVx);
    expect(t).toBeGreaterThan(0);
    const projectileY = dir.y * projectileSpeed * t;
    const targetY = deltaY + targetVy * t;
    expect(projectileY).toBeCloseTo(targetY, 4);
  });

  it('falls back to a direct shot when the target outruns the projectile', () => {
    // Target fleeing straight along +x faster than the projectile can travel.
    const dir = computeLeadDirection(100, 0, 10, 0, 6);
    expect(dir.x).toBeCloseTo(1, 6);
    expect(dir.y).toBeCloseTo(0, 6);
  });

  it('falls back to a direct shot for a stationary projectile', () => {
    const dir = computeLeadDirection(30, 40, 5, 5, 0);
    expect(dir.x).toBeCloseTo(0.6, 6);
    expect(dir.y).toBeCloseTo(0.8, 6);
  });
});

describe('weaponSystem ranged leading', () => {
  it('leads a laterally moving enemy instead of aiming at its current position', () => {
    const world = createTestWorld();
    spawnPlayer(world, 12.5, 12.5);
    // Enemy directly to the right, moving downward (+y) at 0.25 ft/frame.
    const enemy = spawnEnemy(world, 37.5, 12.5, 10);
    world.stores.velocity.x[enemy] = 0;
    world.stores.velocity.y[enemy] = 0.25;

    const bow = getWeaponDef('bow')!;
    setActiveWeapon(world, bow);
    world.elapsedMs = bow.cooldownMs;

    weaponSystem(world);

    const projectiles = Array.from(query(world.ecs, [Projectile, Position, Velocity]));
    expect(projectiles).toHaveLength(1);
    const projectile = projectiles[0]!;
    // A naive shot would have velocityY === 0 (aimed straight right). Leading
    // must impart a downward component to intercept the descending enemy.
    expect(world.stores.velocity.y[projectile]).toBeGreaterThan(0);
  });
});
