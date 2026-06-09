import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Knockback,
  Lifetime,
  MeleeSwing,
  Owner,
  Position,
  Team,
} from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { knockbackSystem } from '../../src/core/systems/knockbackSystem.js';
import { meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { GAME } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { ftToPx } from '../../src/shared/units.js';
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
    expect(world.stores.meleeSwing.bladeLength[swing]).toBe(ftToPx(def.aoeRadius));
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

  it('hammer head hit deals full damage', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const hammer = getWeaponDef('hammer')!;
    // Place enemy at tip distance (within headRadius of the tip)
    const enemy = spawnEnemy(world, 148, 100, 100);
    setActiveWeapon(world, hammer);
    world.elapsedMs = hammer.cooldownMs;

    weaponSystem(world);

    // At progress=0 the blade starts at arcCenter + arcHalf (top of arc)
    // For 360° arc facing right, advance partway so blade sweeps to the right
    for (let i = 0; i < 10; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

    // Should take full damage (25)
    expect(world.stores.health.current[enemy]).toBe(100 - hammer.baseDamage);
  });

  it('hammer shaft hit deals partial damage', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const hammer = getWeaponDef('hammer')!;
    // Place enemy on the shaft (halfway along blade, well inside blade length but outside head)
    const enemy = spawnEnemy(world, 124, 100, 100);
    setActiveWeapon(world, hammer);
    world.elapsedMs = hammer.cooldownMs;

    weaponSystem(world);

    for (let i = 0; i < 10; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

    expect(world.stores.health.current[enemy]).toBeLessThan(100);
    // Shaft damage should be less than full damage
    expect(100 - (world.stores.health.current[enemy] ?? 0)).toBeLessThanOrEqual(
      hammer.baseDamage * hammer.shaftDamageMult,
    );
  });

  it('hammer knockback smoothly displaces enemy away from player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const hammer = getWeaponDef('hammer')!;
    const enemy = spawnEnemy(world, 148, 100, 100);
    setActiveWeapon(world, hammer);
    world.elapsedMs = hammer.cooldownMs;

    weaponSystem(world);

    const beforeX = world.stores.position.x[enemy] ?? 0;

    // Hit the enemy
    for (let i = 0; i < 10; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

    // Enemy should now have Knockback component
    const kbEntities = query(world.ecs, [Knockback]);
    expect(kbEntities).toContain(enemy);

    // Run knockback over several frames — should move smoothly
    const midX1 = world.stores.position.x[enemy] ?? 0;
    knockbackSystem(world);
    const midX2 = world.stores.position.x[enemy] ?? 0;
    expect(midX2).toBeGreaterThan(midX1);

    // Run remaining knockback frames
    for (let i = 0; i < 20; i++) {
      knockbackSystem(world);
    }

    const afterX = world.stores.position.x[enemy] ?? 0;
    // Total displacement should approximately equal knockback value
    expect(afterX - beforeX).toBeCloseTo(ftToPx(hammer.knockback), 0);
  });

  it('sword (no headRadius) deals uniform damage everywhere on blade', () => {
    const world = createTestWorld();
    spawnPlayer(world, 100, 100);
    const sword = getWeaponDef('sword')!;
    expect(sword.headRadius).toBe(0);
    // Place enemy on the shaft (not at tip)
    const enemy = spawnEnemy(world, 124, 100, 50);
    setActiveWeapon(world, sword);
    world.elapsedMs = sword.cooldownMs;

    weaponSystem(world);

    for (let i = 0; i < 10; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

    // Should take full damage since shaftDamageMult defaults to 1.0
    expect(world.stores.health.current[enemy]).toBe(50 - sword.baseDamage);
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

    // Run enough frames for the blade to sweep the full 360°
    // hammer durationMs = 300, DELTA_MS ≈ 16.67, so ~18 frames
    for (let i = 0; i < 20; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

    // Both should be hit as blade sweeps past
    expect(world.stores.health.current[right]).toBeLessThan(50);
    expect(world.stores.health.current[left]).toBeLessThan(50);
  });
});

describe('unarmed weapons', () => {
  it('punch spawns a MeleeSwing with stab style and head', () => {
    const world = createTestWorld();
    spawnPlayer(world, 200, 200);
    spawnEnemy(world, 230, 200, 50);
    const def = getWeaponDef('punch')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const swings = Array.from(query(world.ecs, [MeleeSwing, Position]));
    expect(swings).toHaveLength(1);
    const swing = swings[0]!;
    expect(world.stores.meleeSwing.style[swing]).toBe(1); // STAB
    expect(world.stores.meleeSwing.headRadius[swing]).toBe(ftToPx(def.headRadius));
    expect(world.stores.meleeSwing.shaftDamageMult[swing]).toBe(0);
    expect(world.stores.meleeSwing.knockback[swing]).toBe(ftToPx(def.knockback));
  });

  it('punch head deals damage to enemy within reach', () => {
    const world = createTestWorld();
    spawnPlayer(world, 200, 200);
    // Enemy at 30px — within bladeLength(24) + headRadius(10) = 34px
    const enemy = spawnEnemy(world, 230, 200, 50);
    const def = getWeaponDef('punch')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    // Advance through the stab animation
    for (let i = 0; i < 10; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

    // Punch head should have hit the enemy
    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    expect(world.stores.health.current[enemy]).toBe(50 - def.baseDamage);
  });

  it('punch path still damages because the head overlaps shaft positions', () => {
    const world = createTestWorld();
    spawnPlayer(world, 200, 200);
    // Enemy at 12px — right along the shaft, not near the tip head
    const enemy = spawnEnemy(world, 212, 200, 50);
    const def = getWeaponDef('punch')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    // Advance partway — tip extends past the enemy (only 12px away)
    for (let i = 0; i < 10; i++) {
      world.elapsedMs += GAME.DELTA_MS;
      meleeSwingSystem(world);
    }

    // Enemy at 12px could get shaft hit but shaftDamageMult=0, OR head hit when tip passes through
    // Since headRadius=10 and bladeLength=24, tip passes through distance 12 early
    // At progress where reach=12, tip is at (212,200) — exactly on the enemy, within headRadius
    // So actually the head WILL hit this enemy. This is expected behavior.
    // A true "shaft only" test would need the enemy outside head range but on the shaft line.
    // With headRadius=10 and bladeLength=24, there's only 14px of "shaft" at full extension.
    // An enemy at (205, 200) — 5px from player — would be on shaft when tip is at 24px.
    // But the head passes through at reach=5, which is within headRadius=10 of the enemy too.
    // With headRadius=10 and bladeLength=24, the head sweeps through ALL shaft positions.
    // So punch with shaftDamageMult=0 and headRadius=10 effectively hits everything along the stab.
    // This test just confirms it actually works.
    expect(world.stores.health.current[enemy]).toBeLessThan(50);
  });

  it('kick spawns a 360° MeleeSwing slash', () => {
    const world = createTestWorld();
    spawnPlayer(world, 200, 200);
    spawnEnemy(world, 230, 200, 50);
    const def = getWeaponDef('kick')!;
    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;

    weaponSystem(world);

    const swings = Array.from(query(world.ecs, [MeleeSwing, Position]));
    expect(swings).toHaveLength(1);
    expect(world.stores.meleeSwing.style[swings[0]!]).toBe(0); // SLASH
    expect(def.swingArcDeg).toBe(360);
  });
});
