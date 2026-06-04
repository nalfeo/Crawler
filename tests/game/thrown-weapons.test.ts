import { entityExists, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Position, Projectile, Returning, Velocity } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { returningProjectileSystem } from '../../src/core/systems/returningProjectileSystem.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { GAME } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('thrown weapons', () => {
  it('boomerang spawns a Returning projectile', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 20);
    const def = getWeaponDef('boomerang')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const returning = Array.from(query(world.ecs, [Returning, Projectile, Position, Velocity]));
    expect(returning).toHaveLength(1);
    const r = returning[0]!;
    expect(world.stores.returning.maxRange[r]).toBe(def.maxRange);
    expect(world.stores.returning.returnSpeed[r]).toBe(def.returnSpeed);
    expect(world.stores.returning.isReturning[r]).toBe(0);
  });

  it('boomerang starts returning after exceeding max range', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 500, 0, 20);
    const def = getWeaponDef('boomerang')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const returning = Array.from(query(world.ecs, [Returning]));
    const r = returning[0]!;

    // Move projectile past max range
    for (let i = 0; i < 200; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      movementSystem(world);
      returningProjectileSystem(world);
    }

    // Should have started returning or been collected
    const isReturning = world.stores.returning.isReturning[r] ?? 0;
    const stillExists = entityExists(world.ecs, r);
    // Either it's returning or it's been collected
    expect(isReturning === 1 || !stillExists).toBe(true);
  });

  it('throwing knife has faster speed and shorter range', () => {
    const knife = getWeaponDef('throwing-knife')!;
    const boomerang = getWeaponDef('boomerang')!;
    expect(knife.projectileSpeed).toBeGreaterThan(boomerang.projectileSpeed);
    expect(knife.maxRange).toBeLessThan(boomerang.maxRange);
  });
});
