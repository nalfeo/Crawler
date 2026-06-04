import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage, Lifetime, MeleeSwing, Owner, Position, Team } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { GAME } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('melee weapons', () => {
  it('sword spawns a MeleeSwing entity at player position', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    // Place enemy so swing has a direction
    spawnEnemy(world, 200, 100, 50);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const swings = Array.from(query(world.ecs, [MeleeSwing, Position, Lifetime, Owner]));
    expect(swings).toHaveLength(1);
    const swing = swings[0]!;
    expect(world.stores.position.x[swing]).toBe(100);
    expect(world.stores.position.y[swing]).toBe(100);
    expect(world.stores.meleeSwing.damage[swing]).toBe(def.baseDamage);
    expect(world.stores.meleeSwing.bladeLength[swing]).toBe(def.aoeRadius);
    expect(world.stores.owner.eid[swing]).toBe(player);
  });

  it('sword blade hits enemy via line-segment collision', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    // Place enemy directly right, within blade length
    const enemy = spawnEnemy(world, 130, 100, 50);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    // Advance time partway through the swing so blade reaches the enemy
    world.elapsedMs += def.durationMs / 2;
    meleeSwingSystem(world);

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
  });

  it('sword blade does NOT hit enemy behind (outside arc)', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    // Nearest enemy to the right — arc faces right
    spawnEnemy(world, 130, 100, 50);
    // Enemy directly behind, farther away, within blade length but outside 90° arc
    const behindEnemy = spawnEnemy(world, 65, 100, 50);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    // Run multiple swing frames to cover the full arc
    for (let i = 0; i < 12; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

    // Behind enemy should NOT be hit
    expect(world.stores.health.current[behindEnemy]).toBe(50);
  });

  it('sword blade follows player position', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    spawnEnemy(world, 200, 100, 50);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    // Move player
    world.stores.position.x[player] = 200;
    world.stores.position.y[player] = 200;

    meleeSwingSystem(world);

    const swings = Array.from(query(world.ecs, [MeleeSwing, Position]));
    expect(swings).toHaveLength(1);
    expect(world.stores.position.x[swings[0]!]).toBe(200);
    expect(world.stores.position.y[swings[0]!]).toBe(200);
  });

  it('sword only hits each enemy once per swing', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const enemy = spawnEnemy(world, 130, 100, 50);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    // Run multiple swing ticks — enemy should only take damage once
    for (let i = 0; i < 12; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

    // Should be hit exactly once: 50 - 15 = 35
    expect(world.stores.health.current[enemy]).toBe(50 - def.baseDamage);
  });

  it('sword respects cooldown', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    spawnEnemy(world, 200, 100, 50);
    const def = getWeaponDef('sword')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);
    world.elapsedMs += def.cooldownMs / 2;
    weaponSystem(world);

    expect(query(world.ecs, [MeleeSwing]).length).toBe(1);
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

  it('melee swing has Team component for friendly fire prevention', () => {
    const world = createTestWorld();
    spawnPlayer(world, 50, 50);
    spawnEnemy(world, 100, 50, 50);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.elapsedMs = 1000;

    weaponSystem(world);

    const swings = Array.from(query(world.ecs, [MeleeSwing, Team]));
    expect(swings).toHaveLength(1);
  });

  it('full-circle melee (hammer, 360°) hits in all directions', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const right = spawnEnemy(world, 130, 100, 50);
    const left = spawnEnemy(world, 75, 100, 50);
    const hammer = getWeaponDef('hammer')!;
    expect(hammer.swingArcDeg).toBe(360);
    setActiveWeapon(world, hammer);
    world.elapsedMs = hammer.cooldownMs;

    weaponSystem(world);

    // Run swing frames
    for (let i = 0; i < 12; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

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
