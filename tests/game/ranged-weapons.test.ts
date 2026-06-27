import { entityExists, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Damage, Position, Projectile, Velocity } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer, spawnProjectile } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('ranged weapons', () => {
  it('pistol fires a projectile at the nearest enemy', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 6.25, 0, 20);
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

  it('projectile with pierce=0 is destroyed on first hit', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 1.25, 0, 50);
    const proj = spawnProjectile(world, 1, 0, 0.125, 0, 10, 0);

    const collision = collisionSystem(world);
    damageSystem(world, collision);

    expect(world.stores.health.current[enemy]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(false);
  });

  it('projectile with pierce=2 survives first two hits', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const e1 = spawnEnemy(world, 1.25, 0, 50);
    const e2 = spawnEnemy(world, 2.5, 0, 50);
    const e3 = spawnEnemy(world, 3.75, 0, 50);
    // Pierce=2 means pass through 2 enemies, destroyed on 3rd
    const proj = spawnProjectile(world, 1, 0, 0.125, 0, 10, 2);

    // Hit first enemy
    let collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e1]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(true);

    // Move to second enemy
    world.stores.position.x[proj] = 2.25;
    collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e2]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(true);

    // Move to third enemy — should be destroyed
    world.stores.position.x[proj] = 3.5;
    collision = collisionSystem(world);
    damageSystem(world, collision);
    expect(world.stores.health.current[e3]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(false);
  });

  it('piercing projectile does not double-hit the same enemy', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 1.25, 0, 50);
    const proj = spawnProjectile(world, 1, 0, 0, 0, 10, 5);

    // Run collision twice while overlapping same enemy
    let collision = collisionSystem(world);
    damageSystem(world, collision);
    collision = collisionSystem(world);
    damageSystem(world, collision);

    // Should only take damage once
    expect(world.stores.health.current[enemy]).toBe(40);
    expect(entityExists(world.ecs, proj)).toBe(true);
  });

  it('ranged miss still fires a projectile that travels wide', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // Enemy to the right; projectile should aim right but deflect off-axis
    spawnEnemy(world, 12.5, 0, 20);
    const def = getWeaponDef('pistol')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;
    // Force a deterministic miss
    world.rng.next = () => 1.0;

    weaponSystem(world);

    // Miss event emitted
    expect(world.combatEvents.some((e) => e.type === 'miss')).toBe(true);
    // A wide-shot projectile must be spawned
    const projectiles = Array.from(query(world.ecs, [Projectile, Position, Velocity, Damage]));
    expect(projectiles).toHaveLength(1);
    const p = projectiles[0]!;
    // Damage must be 0 — purely cosmetic
    expect(world.stores.damage.amount[p]).toBe(0);
    // Velocity must be non-zero and deflected off the direct aim axis (vy ≠ 0)
    const vx = world.stores.velocity.x[p]!;
    const vy = world.stores.velocity.y[p]!;
    expect(Math.hypot(vx, vy)).toBeGreaterThan(0);
    expect(Math.abs(vy)).toBeGreaterThan(0); // non-zero y component = deflected wide
  });

  it('ranged miss projectile deals no damage on contact', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 12.5, 0, 20);
    const def = getWeaponDef('pistol')!;
    const initialHp = world.stores.health.current[enemy]!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;
    world.rng.next = () => 1.0; // force miss

    weaponSystem(world);

    // Place the miss projectile directly on the enemy to force collision
    const projectiles = Array.from(query(world.ecs, [Projectile]));
    expect(projectiles).toHaveLength(1);
    world.stores.position.x[projectiles[0]!] = 12.5;
    world.stores.position.y[projectiles[0]!] = 0;

    const collision = collisionSystem(world);
    damageSystem(world, collision);

    // Enemy must remain at full HP — miss projectile is harmless
    expect(world.stores.health.current[enemy]).toBe(initialHp);
  });
});
