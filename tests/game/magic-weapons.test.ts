import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AoeOnImpact, Position, Projectile, Velocity } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('magic weapons', () => {
  it('fireball spawns a projectile with AoeOnImpact', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 30);
    const def = getWeaponDef('fireball')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const projectiles = Array.from(query(world.ecs, [Projectile, AoeOnImpact, Position, Velocity]));
    expect(projectiles).toHaveLength(1);
    const p = projectiles[0]!;
    expect(world.stores.aoeOnImpact.radius[p]).toBe(def.aoeRadius);
    expect(world.stores.aoeOnImpact.damage[p]).toBe(def.baseDamage);
    expect(world.stores.velocity.x[p]).toBeCloseTo(def.projectileSpeed, 2);
  });

  it('fireball respects cooldown', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 30); // must have a visible enemy
    const def = getWeaponDef('fireball')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    world.elapsedMs += def.cooldownMs / 2;
    weaponSystem(world);

    expect(query(world.ecs, [AoeOnImpact]).length).toBe(1);
  });

  it('a missed fireball still casts a spell projectile, not a stray arrow', () => {
    // Regression: a MAGIC miss used to call fireRangedAttack (a plain arrow) so a
    // whiffed spell visibly shot an arrow. A miss must fire the spell's own AoE
    // projectile, just deflected wide with zero damage.
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 30);
    const def = { ...getWeaponDef('fireball')!, baseAccuracy: 0 };
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const aoeProjectiles = Array.from(query(world.ecs, [Projectile, AoeOnImpact]));
    expect(aoeProjectiles).toHaveLength(1);
    // Plain arrow projectiles never carry AoeOnImpact — every spawned projectile
    // must be the AoE spell projectile.
    expect(query(world.ecs, [Projectile]).length).toBe(aoeProjectiles.length);
    // The whiff deals no damage.
    expect(world.stores.aoeOnImpact.damage[aoeProjectiles[0]!]).toBe(0);
  });
});
