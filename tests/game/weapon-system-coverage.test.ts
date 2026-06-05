import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  AreaDamage,
  Damage,
  Owner,
  Position,
  Projectile,
  Stats,
  Team,
  Velocity,
  Weapon,
} from '../../src/core/components.js';
import { createEntity, spawnEnemy, spawnPlayer, spawnWeapon } from '../../src/core/helpers.js';
import {
  clearActiveWeapon,
  configureWeaponSystem,
  getActiveWeapon,
  setActiveWeapon,
  weaponEntitySystem,
  weaponSystem,
} from '../../src/game/weaponSystem.js';
import { TeamId, WEAPON, WeaponType, type WeaponTypeValue } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('weaponSystem coverage paths', () => {
  it('fires spread projectiles when projectileCount grants extras', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    addComponent(world.ecs, player, Stats);
    world.stores.stats.attackSpeed[player] = 1;
    world.stores.stats.damage[player] = WEAPON.BASE_DAMAGE;
    world.stores.stats.projectileCount[player] = 2;
    world.elapsedMs = WEAPON.FIRE_RATE_MS;

    weaponSystem(world);

    const projectiles = Array.from(query(world.ecs, [Projectile, Position]));
    expect(projectiles).toHaveLength(3);
    const velocityYs = projectiles.map((eid) => world.stores.velocity.y[eid] ?? 0);
    expect(velocityYs.some((vy) => Math.abs(vy) > 0.0001)).toBe(true);
  });

  it('keeps cooldown when updating active weapon and can return to legacy mode', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);

    const fireball = getWeaponDef('fireball')!;
    setActiveWeapon(world, fireball);
    world.elapsedMs = fireball.cooldownMs;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);

    // Same id should update the active def but not reset cooldown.
    setActiveWeapon(world, { ...fireball, baseDamage: fireball.baseDamage + 7 });
    world.elapsedMs += 1;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);

    clearActiveWeapon(world);
    expect(getActiveWeapon(world)).toBeUndefined();
    world.elapsedMs += WEAPON.FIRE_RATE_MS;
    weaponSystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(2);
  });

  it('returns early when no player exists', () => {
    const world = createTestWorld();
    world.elapsedMs = WEAPON.FIRE_RATE_MS;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });

  it('uses velocity-derived aim when no enemy is present', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    addComponent(world.ecs, player, set(Velocity, { x: 0, y: 4 }));
    world.elapsedMs = WEAPON.FIRE_RATE_MS;

    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile])[0];
    expect(projectile).toBeDefined();
    expect(world.stores.velocity.x[projectile!]).toBeCloseTo(0, 5);
    expect(world.stores.velocity.y[projectile!]).toBeCloseTo(WEAPON.PROJECTILE_SPEED, 5);
  });

  it('applies Damage component overrides in legacy mode', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    addComponent(world.ecs, player, set(Damage, { amount: 11, cooldownMs: 25, lastFireMs: 0 }));
    configureWeaponSystem(world, { baseDamage: 99, fireRateMs: 1000, projectileSpeed: 300 });
    world.elapsedMs = 25;

    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile, Damage])[0];
    expect(projectile).toBeDefined();
    expect(world.stores.damage.amount[projectile!]).toBe(11);
    expect(world.stores.damage.lastFireMs[player]).toBe(25);
    expect(world.stores.damage.cooldownMs[player]).toBe(25);
  });

  it('falls back to configured values when Damage overrides are non-positive', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    addComponent(world.ecs, player, set(Damage, { amount: 0, cooldownMs: 0, lastFireMs: 0 }));
    configureWeaponSystem(world, { baseDamage: 21, fireRateMs: 40, projectileSpeed: 180 });
    world.elapsedMs = 40;

    weaponSystem(world);

    const projectile = query(world.ecs, [Projectile, Damage])[0];
    expect(projectile).toBeDefined();
    expect(world.stores.damage.amount[projectile!]).toBe(21);
    expect(world.stores.damage.cooldownMs[player]).toBe(40);
    expect(world.stores.damage.cooldownMs[player]).toBe(40);
  });

  it('handles unknown active weapon types without spawning an attack', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    const def = { ...getWeaponDef('fireball')!, weaponType: 255 as unknown as WeaponTypeValue };
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
  });
});

describe('weaponEntitySystem coverage paths', () => {
  it('skips firing when owner has no position', () => {
    const world = createTestWorld();
    const owner = createEntity(world);
    const weapon = spawnWeapon(world, owner, WeaponType.RANGED, 12, 100, 0, 300, TeamId.PLAYER);
    world.elapsedMs = 100;

    weaponEntitySystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(0);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(-100);
  });

  it('fires ranged weapon entities and respects cooldown gating', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 10, 20);
    spawnEnemy(world, 100, 20, 50);
    const weapon = spawnWeapon(world, owner, WeaponType.RANGED, 20, 50, 0, 200, TeamId.PLAYER);

    world.elapsedMs = 50;
    weaponEntitySystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(50);

    world.elapsedMs = 75;
    weaponEntitySystem(world);
    expect(query(world.ecs, [Projectile]).length).toBe(1);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(50);
  });

  it('uses owner team for melee attacks and falls back to player team', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 50, 0, 50);
    addComponent(world.ecs, owner, set(Team, { id: TeamId.ENEMY }));
    spawnWeapon(world, owner, WeaponType.MELEE, 15, 10, 33, 0, TeamId.PLAYER);
    world.elapsedMs = 10;

    weaponEntitySystem(world);

    const firstArea = query(world.ecs, [AreaDamage, Team])[0];
    expect(firstArea).toBeDefined();
    expect(world.stores.team.id[firstArea!]).toBe(TeamId.ENEMY);
    expect(world.stores.areaDamage.radius[firstArea!]).toBe(33);

    const owner2 = spawnPlayer(world, 5, 5);
    spawnWeapon(world, owner2, WeaponType.MELEE, 10, 10, 20, 0, TeamId.PLAYER);
    world.elapsedMs = 20;
    weaponEntitySystem(world);

    const areas = Array.from(query(world.ecs, [AreaDamage, Owner, Team]));
    const owner2Area = areas.find((eid) => (world.stores.owner.eid[eid] ?? -1) === owner2);
    expect(owner2Area).toBeDefined();
    expect(world.stores.team.id[owner2Area!]).toBe(TeamId.PLAYER);
  });

  it('falls back to projectile spawn for unknown weapon type', () => {
    const world = createTestWorld();
    const owner = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 50);
    const weapon = createEntity(world);
    addComponent(
      world.ecs,
      weapon,
      set(Weapon, {
        weaponType: 255,
        baseDamage: 9,
        cooldownMs: 10,
        lastFireMs: 0,
        range: 0,
        projectileSpeed: 120,
      }),
    );
    addComponent(world.ecs, weapon, set(Owner, { eid: owner }));
    world.elapsedMs = 10;

    weaponEntitySystem(world);

    expect(query(world.ecs, [Projectile]).length).toBe(1);
    expect(world.stores.weapon.lastFireMs[weapon]).toBe(10);
  });
});
