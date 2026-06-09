import { entityExists, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Position, Projectile, Returning, Velocity } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { returningProjectileSystem } from '../../src/core/systems/returningProjectileSystem.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { ftToPx } from '../../src/shared/units.js';
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
    expect(world.stores.returning.maxRange[r]).toBe(ftToPx(def.maxRange));
    expect(world.stores.returning.returnSpeed[r]).toBe(def.returnSpeed);
    expect(world.stores.returning.isReturning[r]).toBe(0);
    expect(world.stores.projectile.pierce[r]).toBe(def.pierce);
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
    expect(knife.range).toBeLessThan(boomerang.maxRange);
  });

  it('throwing knife does not spawn a returning projectile by default', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 20);
    const def = getWeaponDef('throwing-knife')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const projectiles = Array.from(query(world.ecs, [Projectile]));
    const returning = Array.from(query(world.ecs, [Returning]));
    expect(projectiles).toHaveLength(1);
    expect(returning).toHaveLength(0);
  });

  it('boomerang returns after hitting its final outbound target (1 + pierce)', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const e1 = spawnEnemy(world, 10, 0, 50);
    const e2 = spawnEnemy(world, 20, 0, 50);
    const def = { ...getWeaponDef('boomerang')!, pierce: 1 };
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const boomerang = Array.from(query(world.ecs, [Returning, Projectile]))[0]!;

    // First outbound hit: still outbound
    world.stores.position.x[boomerang] = 8;
    let collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e1]).toBe(40);
    expect(world.stores.returning.isReturning[boomerang]).toBe(0);

    // Second outbound hit: exceeds pierce budget, should switch to return
    world.stores.position.x[boomerang] = 18;
    collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e2]).toBe(40);
    expect(world.stores.returning.isReturning[boomerang]).toBe(1);
    expect(entityExists(world.ecs, boomerang)).toBe(true);
  });

  it('returning boomerang has infinite pierce and can re-hit outbound targets', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const e1 = spawnEnemy(world, 10, 0, 50);
    const def = { ...getWeaponDef('boomerang')!, pierce: 0 };
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const boomerang = Array.from(query(world.ecs, [Returning, Projectile]))[0]!;

    // First hit uses up outbound budget and should trigger return
    world.stores.position.x[boomerang] = 8;
    let collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e1]).toBe(40);
    expect(world.stores.returning.isReturning[boomerang]).toBe(1);
    expect(world.stores.projectile.pierce[boomerang]).toBe(255);

    // On return, same enemy can be hit again and projectile does not despawn
    collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e1]).toBe(30);
    expect(entityExists(world.ecs, boomerang)).toBe(true);
  });
});
