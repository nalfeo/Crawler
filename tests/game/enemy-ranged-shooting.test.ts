import { hasComponent, query } from 'bitecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Damage, EnemyProjectile, Owner, Position, Projectile } from '../../src/core/components.js';
import {
  collisionSystem,
  damageSystem,
  spawnBehaviorEnemy,
  spawnEnemyProjectile,
  spawnPlayer,
  spawnProjectile,
} from '../../src/core/index.js';
import { AI_TYPE, enemyAISystem } from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('enemy ranged shooting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ranged enemy fires a projectile when within attack range', () => {
    const world = createTestWorld();
    world.elapsedMs = 100; // ensure cooldown passes
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);

    const projectiles = query(world.ecs, [EnemyProjectile, Projectile, Position]);
    expect(projectiles.length).toBe(1);

    const proj = projectiles[0] as number;
    // Projectile should be aimed toward the player (negative x direction)
    expect(world.stores.velocity.x[proj]).toBeLessThan(0);
  });

  it('ranged enemy respects fire cooldown', () => {
    const world = createTestWorld();
    world.elapsedMs = 100;
    vi.spyOn(world.rng, 'next').mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    // First call — should fire
    enemyAISystem(world);
    const count1 = query(world.ecs, [EnemyProjectile]).length;
    expect(count1).toBe(1);

    // Advance only slightly — should NOT fire again
    world.elapsedMs = 200;
    enemyAISystem(world);
    const count2 = query(world.ecs, [EnemyProjectile]).length;
    expect(count2).toBe(1);

    // Advance past cooldown (default 1200ms)
    world.elapsedMs = 1500;
    enemyAISystem(world);
    const count3 = query(world.ecs, [EnemyProjectile]).length;
    expect(count3).toBe(2);
  });

  it('ranged enemy can miss when the accuracy roll fails', () => {
    const world = createTestWorld();
    world.elapsedMs = 100;
    // First roll misses (0.95 > 0.9), later rolls can hit.
    vi.spyOn(world.rng, 'next').mockReturnValueOnce(0.95).mockReturnValue(0);

    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 100, 0, 20, AI_TYPE.RANGED, 1.5, 200, 150);

    enemyAISystem(world);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);
    expect(world.stores.enemyBehavior.lastFireMs[enemy]).toBe(100);

    // Cooldown should be consumed even on miss, so this immediate follow-up still cannot fire.
    world.elapsedMs = 200;
    enemyAISystem(world);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);

    // After cooldown, a successful roll can fire again.
    world.elapsedMs = 1500;
    enemyAISystem(world);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(1);
  });

  it('ranged enemy does NOT fire when out of attack range', () => {
    const world = createTestWorld();
    world.elapsedMs = 100;

    spawnPlayer(world, 0, 0);
    // Place enemy far away — beyond attack range of 150
    spawnBehaviorEnemy(world, 300, 0, 20, AI_TYPE.RANGED, 1.5, 400, 150);

    enemyAISystem(world);

    const projectiles = query(world.ecs, [EnemyProjectile]).length;
    expect(projectiles).toBe(0);
  });

  it('chase enemies do NOT fire projectiles', () => {
    const world = createTestWorld();
    world.elapsedMs = 100;

    spawnPlayer(world, 0, 0);
    spawnBehaviorEnemy(world, 50, 0, 20, AI_TYPE.CHASE, 2, 200, 0);

    enemyAISystem(world);

    const projectiles = query(world.ecs, [EnemyProjectile]).length;
    expect(projectiles).toBe(0);
  });
});

describe('enemy projectile damage', () => {
  it('enemy projectile damages the player and is destroyed', () => {
    const world = createTestWorld();
    world.elapsedMs = 100;

    const player = spawnPlayer(world, 50, 50);
    const projEid = spawnEnemyProjectile(world, 50, 50, 1, 0, 15);

    // Create a collision between them
    const collisionResult = collisionSystem(world);
    damageSystem(world, collisionResult);

    expect(world.stores.health.current[player]).toBe(85); // 100 - 15
    // Projectile should be destroyed
    expect(hasComponent(world.ecs, projEid, EnemyProjectile)).toBe(false);
  });

  it('records the firing enemy (not the transient projectile) as the player last attacker', () => {
    // Floor 2 Slice 3 ally-defend (bug 2): the projectile is destroyed on
    // impact, so the retaliation source must be the shooter threaded through
    // Owner — never the projectile eid, which no longer exists next frame.
    const world = createTestWorld();
    world.elapsedMs = 100;

    spawnPlayer(world, 50, 50);
    const shooter = spawnBehaviorEnemy(world, 60, 50, 30, AI_TYPE.RANGED, 1, 200, 150);
    const projEid = spawnEnemyProjectile(world, 50, 50, 1, 0, 15, shooter);

    const collisionResult = collisionSystem(world);
    damageSystem(world, collisionResult);

    expect(world.lastPlayerHit?.attackerEid).toBe(shooter);
    expect(world.lastPlayerHit?.attackerEid).not.toBe(projEid);
    // The projectile is gone, so the recorded attacker is a live enemy.
    expect(hasComponent(world.ecs, projEid, EnemyProjectile)).toBe(false);
    expect(hasComponent(world.ecs, shooter, Position)).toBe(true);
  });

  it('enemy projectile does NOT damage enemies', () => {
    const world = createTestWorld();
    world.elapsedMs = 100;

    spawnPlayer(world, 200, 200); // far away
    const enemy = spawnBehaviorEnemy(world, 50, 50, 30, AI_TYPE.CHASE, 2, 200, 0);
    spawnEnemyProjectile(world, 50, 50, 1, 0, 20);

    const collisionResult = collisionSystem(world);
    damageSystem(world, collisionResult);

    // Enemy should NOT take damage from friendly projectile
    expect(world.stores.health.current[enemy]).toBe(30);
  });

  it('player projectile does NOT damage the player', () => {
    const world = createTestWorld();
    world.elapsedMs = 100;

    const player = spawnPlayer(world, 50, 50);
    spawnProjectile(world, 50, 50, 1, 0, 20);

    const collisionResult = collisionSystem(world);
    damageSystem(world, collisionResult);

    // Player should NOT take damage from their own projectile
    expect(world.stores.health.current[player]).toBe(100);
  });

  it('player projectile still damages enemies', () => {
    const world = createTestWorld();
    world.elapsedMs = 100;

    spawnPlayer(world, 200, 200);
    const enemy = spawnBehaviorEnemy(world, 50, 50, 30, AI_TYPE.CHASE, 2, 200, 0);
    const proj = spawnProjectile(world, 50, 50, 1, 0, 10);

    const collisionResult = collisionSystem(world);
    damageSystem(world, collisionResult);

    expect(world.stores.health.current[enemy]).toBe(20); // 30 - 10
    expect(hasComponent(world.ecs, proj, Projectile)).toBe(false);
  });

  it('preserves the player owner on projectile hit events for kill attribution', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 200, 200);
    const enemy = spawnBehaviorEnemy(world, 50, 50, 10, AI_TYPE.CHASE, 2, 200, 0);
    spawnProjectile(world, 50, 50, 1, 0, 10, 0, 0, 1, player);

    damageSystem(world, collisionSystem(world));

    const hit = world.combatEvents.find(
      (event) => event.type === 'hit' && event.targetEid === enemy,
    );
    expect(hit?.sourceEid).toBe(player);
  });

  it('enemy projectile respects player invincibility window', () => {
    const world = createTestWorld();
    world.elapsedMs = 100;

    const player = spawnPlayer(world, 50, 50);

    // First hit at t=100ms
    spawnEnemyProjectile(world, 50, 50, 1, 0, 10);
    let cr = collisionSystem(world);
    damageSystem(world, cr);
    expect(world.stores.health.current[player]).toBe(90);

    // Immediately spawn another — should be blocked by invincibility
    spawnEnemyProjectile(world, 50, 50, -1, 0, 10);
    cr = collisionSystem(world);
    damageSystem(world, cr);
    expect(world.stores.health.current[player]).toBe(90); // unchanged

    // At t=400ms (300ms after first hit) — still inside the 350ms window, must be blocked.
    // With the old 250ms window this would have been accepted; with 350ms it must not be.
    world.elapsedMs = 400;
    spawnEnemyProjectile(world, 50, 50, 0, -1, 10);
    cr = collisionSystem(world);
    damageSystem(world, cr);
    expect(world.stores.health.current[player]).toBe(90); // still blocked

    // At t=450ms (exactly 350ms after first hit) — invincibility has expired, damage accepted.
    world.elapsedMs = 450;
    spawnEnemyProjectile(world, 50, 50, 0, 1, 10);
    cr = collisionSystem(world);
    damageSystem(world, cr);
    expect(world.stores.health.current[player]).toBe(80);
  });
});

describe('spawnEnemyProjectile', () => {
  it('creates entity with both Projectile and EnemyProjectile tags', () => {
    const world = createTestWorld();
    const eid = spawnEnemyProjectile(world, 10, 20, 3, 4, 5);

    expect(hasComponent(world.ecs, eid, Projectile)).toBe(true);
    expect(hasComponent(world.ecs, eid, EnemyProjectile)).toBe(true);
    expect(hasComponent(world.ecs, eid, Damage)).toBe(true);
    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(world.stores.damage.amount[eid]).toBe(5);
    expect(world.stores.position.x[eid]).toBe(10);
    expect(world.stores.position.y[eid]).toBe(20);
  });

  it('omits Owner when no ownerEid is supplied', () => {
    const world = createTestWorld();
    const eid = spawnEnemyProjectile(world, 10, 20, 3, 4, 5);
    expect(hasComponent(world.ecs, eid, Owner)).toBe(false);
  });

  it('attaches Owner = the firing enemy when ownerEid is supplied', () => {
    const world = createTestWorld();
    const shooter = spawnBehaviorEnemy(world, 0, 0, 30, AI_TYPE.RANGED, 1, 200, 150);
    const eid = spawnEnemyProjectile(world, 10, 20, 3, 4, 5, shooter);
    expect(hasComponent(world.ecs, eid, Owner)).toBe(true);
    expect(world.stores.owner.eid[eid]).toBe(shooter);
  });
});
