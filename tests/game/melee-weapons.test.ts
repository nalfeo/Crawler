import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage, Lifetime, Owner, Position, Team } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { areaDamageSystem } from '../../src/core/systems/areaDamageSystem.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('melee weapons', () => {
  it('sword spawns an AreaDamage entity at player position', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const areas = Array.from(query(world.ecs, [AreaDamage, Position, Lifetime, Owner]));
    expect(areas).toHaveLength(1);
    const aoe = areas[0]!;
    expect(world.stores.position.x[aoe]).toBe(100);
    expect(world.stores.position.y[aoe]).toBe(100);
    expect(world.stores.areaDamage.damage[aoe]).toBe(def.baseDamage);
    expect(world.stores.areaDamage.radius[aoe]).toBe(def.aoeRadius);
    expect(world.stores.owner.eid[aoe]).toBe(player);
  });

  it('sword spawns arc attack with correct arc data', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    // Place enemy to the right so arc faces right (angle ≈ 0)
    spawnEnemy(world, 200, 100, 50);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const areas = Array.from(query(world.ecs, [AreaDamage, Position]));
    expect(areas).toHaveLength(1);
    const aoe = areas[0]!;
    const arcHalfRad = world.stores.areaDamage.arcHalfRad[aoe] ?? 0;
    expect(arcHalfRad).toBeGreaterThan(0);
    expect(arcHalfRad).toBeLessThan(Math.PI);
    // Sword is 90° → arcHalfRad should be 45° = π/4
    expect(arcHalfRad).toBeCloseTo(Math.PI / 4, 4);
  });

  it('sword arc hits enemy inside arc', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const enemy = spawnEnemy(world, 130, 100, 50); // directly right
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
  });

  it('sword arc does NOT hit enemy outside arc', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    // Enemy to the right (targeted)
    spawnEnemy(world, 130, 100, 50);
    // Enemy directly behind (opposite direction, outside 90° arc)
    const behindEnemy = spawnEnemy(world, 70, 100, 50);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    // Behind enemy should NOT be hit (outside 90° arc facing right)
    expect(world.stores.health.current[behindEnemy]).toBe(50);
  });

  it('sword arc hits near the π/-π boundary correctly', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    // Place enemy to the left — arc faces left (angle ≈ π, near the wrap boundary)
    const target = spawnEnemy(world, 70, 100, 50);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    // Should be hit — within range and within arc
    expect(world.stores.health.current[target]).toBeLessThan(50);
  });

  it('sword respects cooldown', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    world.elapsedMs += def.cooldownMs / 2;
    weaponSystem(world);

    expect(query(world.ecs, [AreaDamage]).length).toBe(1);
  });

  it('knife has faster cooldown than sword', () => {
    const knife = getWeaponDef('knife')!;
    const sword = getWeaponDef('sword')!;
    expect(knife.cooldownMs).toBeLessThan(sword.cooldownMs);
  });

  it('hammer has higher damage and longer cooldown', () => {
    const hammer = getWeaponDef('hammer')!;
    const sword = getWeaponDef('sword')!;
    expect(hammer.baseDamage).toBeGreaterThan(sword.baseDamage);
    expect(hammer.cooldownMs).toBeGreaterThan(sword.cooldownMs);
  });

  it('melee attack has Team component for friendly fire prevention', () => {
    const world = createTestWorld();
    spawnPlayer(world, 50, 50);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.elapsedMs = 1000;

    weaponSystem(world);

    const areas = Array.from(query(world.ecs, [AreaDamage, Team]));
    expect(areas).toHaveLength(1);
  });

  it('full-circle melee (swingArcDeg=360) hits in all directions', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    // Place enemies in all directions within range
    const right = spawnEnemy(world, 120, 100, 50);
    const left = spawnEnemy(world, 80, 100, 50);
    const hammer = getWeaponDef('hammer')!;
    // Hammer defaults to 360° arc
    expect(hammer.swingArcDeg).toBe(360);
    setActiveWeapon(world, hammer);
    world.elapsedMs = hammer.cooldownMs;

    weaponSystem(world);
    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    // Both should be hit
    expect(world.stores.health.current[right]).toBeLessThan(50);
    expect(world.stores.health.current[left]).toBeLessThan(50);
  });
});

describe('unarmed weapons', () => {
  it('punch spawns a short-range AreaDamage', () => {
    const world = createTestWorld();
    spawnPlayer(world, 200, 200);
    const def = getWeaponDef('punch')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const areas = Array.from(query(world.ecs, [AreaDamage, Position]));
    expect(areas).toHaveLength(1);
    expect(world.stores.areaDamage.radius[areas[0]!]).toBe(def.aoeRadius);
    expect(world.stores.areaDamage.damage[areas[0]!]).toBe(def.baseDamage);
  });

  it('kick has shorter cooldown range than punch', () => {
    const punch = getWeaponDef('punch')!;
    const kick = getWeaponDef('kick')!;
    expect(kick.cooldownMs).toBeGreaterThan(punch.cooldownMs);
    expect(kick.baseDamage).toBeGreaterThan(punch.baseDamage);
  });
});
