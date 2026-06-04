import { entityExists, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Damage, Position, Projectile, Velocity } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer, spawnProjectile } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { WEAPON } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('ranged weapons', () => {
  it('pistol fires a projectile at the nearest enemy', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 50, 0, 20);
    const def = getWeaponDef('pistol')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const projectiles = Array.from(query(world.ecs, [Projectile, Position, Velocity, Damage]));
    expect(projectiles).toHaveLength(1);
    const p = projectiles[0]!;
    expect(world.stores.velocity.x[p]).toBeCloseTo(def.projectileSpeed, 2);
    expect(world.stores.velocity.y[p]).toBeCloseTo(0, 2);
    expect(world.stores.damage.amount[p]).toBe(def.baseDamage);
  });

  it('bow fires slower but deals more damage than pistol', () => {
    const bow = getWeaponDef('bow')!;
    const pistol = getWeaponDef('pistol')!;
    expect(bow.cooldownMs).toBeGreaterThan(pistol.cooldownMs);
    expect(bow.baseDamage).toBeGreaterThan(pistol.baseDamage);
  });

  it('crossbow is the slowest ranged weapon with highest damage', () => {
    const crossbow = getWeaponDef('crossbow')!;
    const bow = getWeaponDef('bow')!;
    expect(crossbow.cooldownMs).toBeGreaterThan(bow.cooldownMs);
    expect(crossbow.baseDamage).toBeGreaterThan(bow.baseDamage);
  });

  it('legacy mode still works without setActiveWeapon', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    world.elapsedMs = WEAPON.FIRE_RATE_MS;

    weaponSystem(world);

    const projectiles = Array.from(query(world.ecs, [Projectile]));
    expect(projectiles).toHaveLength(1);
  });

  it('projectile with pierce=0 is destroyed on first hit', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 10, 0, 50);
    const proj = spawnProjectile(world, 8, 0, 1, 0, 10, 0);

    const collision = collisionSystem(world);
    damageSystem(world, collision);

    expect(world.stores.health.current[enemy]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(false);
  });

  it('projectile with pierce=2 survives first two hits', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const e1 = spawnEnemy(world, 10, 0, 50);
    const e2 = spawnEnemy(world, 20, 0, 50);
    const e3 = spawnEnemy(world, 30, 0, 50);
    // Pierce=2 means pass through 2 enemies, destroyed on 3rd
    const proj = spawnProjectile(world, 8, 0, 1, 0, 10, 2);

    // Hit first enemy
    let collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e1]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(true);

    // Move to second enemy
    world.stores.position.x[proj] = 18;
    collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e2]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(true);

    // Move to third enemy — should be destroyed
    world.stores.position.x[proj] = 28;
    collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e3]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(false);
  });

  it('piercing projectile does not double-hit the same enemy', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 10, 0, 50);
    const proj = spawnProjectile(world, 8, 0, 0, 0, 10, 5);

    // Run collision twice while overlapping same enemy
    let collision = collisionSystem(world);
    damageSystem(world, collision);
    collision = collisionSystem(world);
    damageSystem(world, collision);

    // Should only take damage once
    expect(world.stores.health.current[enemy]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(true);
  });
});
