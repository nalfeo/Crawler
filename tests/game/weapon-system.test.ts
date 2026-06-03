import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Damage, Position, Projectile, Velocity } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { weaponSystem } from '../../src/game/weaponSystem.js';
import { WEAPON } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('weaponSystem', () => {
  it('spawns a projectile when the cooldown has elapsed', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 120);
    world.elapsedMs = WEAPON.FIRE_RATE_MS;

    weaponSystem(world);

    const projectiles = Array.from(query(world.ecs, [Projectile, Position, Velocity, Damage]));
    expect(projectiles).toHaveLength(1);

    const projectile = projectiles[0];
    expect(projectile).toBeDefined();
    expect(world.stores.position.x[projectile!]).toBe(100);
    expect(world.stores.position.y[projectile!]).toBe(120);
    expect(world.stores.damage.amount[projectile!]).toBe(WEAPON.BASE_DAMAGE);
  });

  it('aims projectiles at the nearest enemy', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 30, 0, 20);
    spawnEnemy(world, 0, 40, 20);
    world.elapsedMs = WEAPON.FIRE_RATE_MS;

    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();

    const velocityX = world.stores.velocity.x[projectile!];
    const velocityY = world.stores.velocity.y[projectile!];

    expect(velocityX).toBeCloseTo(WEAPON.PROJECTILE_SPEED, 5);
    expect(velocityY).toBeCloseTo(0, 5);
  });

  it('does not spawn a projectile while the weapon is on cooldown', () => {
    const world = createTestWorld();
    spawnPlayer(world, 64, 64);
    world.elapsedMs = WEAPON.FIRE_RATE_MS;

    weaponSystem(world);
    world.elapsedMs += WEAPON.FIRE_RATE_MS / 2;
    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
  });
});
