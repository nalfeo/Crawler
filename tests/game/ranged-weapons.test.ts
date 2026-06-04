import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Damage, Position, Projectile, Velocity } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
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
});
