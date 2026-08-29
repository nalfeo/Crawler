import { addComponent, entityExists, hasComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  BroadcastScore,
  DeathTimer,
  EnemyProjectile,
  Owner,
  Position,
  Projectile,
  Size,
  Sprite,
  Team,
} from '../../src/core/components.js';
import { createEntity, spawnEnemy, spawnPlayer, spawnXpGem } from '../../src/core/helpers.js';
import { spawnEnemyProjectile } from '../../src/core/spawners/projectiles.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { SHAPE_CIRCLE } from '../../src/core/physics-defs.js';
import { TeamId } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('damageSystem', () => {
  it('reduces enemy health when a projectile hits', () => {
    const world = createTestWorld();
    const projectile = createEntity(world);
    const enemy = spawnEnemy(world, 1, 0, 25);

    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Sprite, { textureId: 0, width: 8, height: 8 }));
    addComponent(
      world.ecs,
      projectile,
      set(Size, { radius: 4, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
    );
    addComponent(world.ecs, projectile, Projectile);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBe(15);
  });

  it('reduces player health when an enemy hits', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);

    spawnEnemy(world, 1, 0, 25);
    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(95);
  });

  it('does not deal contact damage when the enemy is a corpse (DeathTimer)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 8, 0, 25);

    // The enemy died and is in its death-linger window: it keeps the Enemy
    // component but must not damage the player on contact.
    addComponent(world.ecs, enemy, set(DeathTimer, { remainingMs: 300 }));

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(100);
    expect(world.combatEvents).toHaveLength(0);
  });

  it('xp gem collection is handled by itemPickupSystem (not damageSystem)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const gem = spawnXpGem(world, 0.5, 0, 7);

    addComponent(world.ecs, player, set(BroadcastScore, { current: 0 }));

    // damageSystem no longer handles XP gem collection — it's in itemPickupSystem
    damageSystem(world, collisionSystem(world));

    // Gem should still exist (damageSystem doesn't pick it up anymore)
    expect(entityExists(world.ecs, gem)).toBe(true);
  });

  it('destroys projectiles after they hit enemies', () => {
    const world = createTestWorld();
    const projectile = createEntity(world);

    spawnEnemy(world, 1, 0, 25);
    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Sprite, { textureId: 0, width: 8, height: 8 }));
    addComponent(
      world.ecs,
      projectile,
      set(Size, { radius: 4, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
    );
    addComponent(world.ecs, projectile, Projectile);

    damageSystem(world, collisionSystem(world));

    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('emits a hit combat event when a projectile damages an enemy', () => {
    const world = createTestWorld();
    const projectile = createEntity(world);
    spawnEnemy(world, 1, 0, 25);

    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Sprite, { textureId: 0, width: 8, height: 8 }));
    addComponent(
      world.ecs,
      projectile,
      set(Size, { radius: 4, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
    );
    addComponent(world.ecs, projectile, Projectile);

    damageSystem(world, collisionSystem(world));

    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'hit',
      amount: 10,
      targetType: 'enemy',
    });
  });

  it('emits a hit combat event when an enemy damages the player', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 1, 0, 25);

    damageSystem(world, collisionSystem(world));

    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'hit',
      targetType: 'player',
    });
    expect(world.combatEvents[0]!.amount).toBeGreaterThan(0);
  });

  it('does not damage the player with same-team enemy projectiles', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const ally = spawnEnemy(world, 0, 0, 25);
    addComponent(world.ecs, ally, set(Team, { id: TeamId.PLAYER }));
    const projectile = spawnEnemyProjectile(world, 0, 0, 0, 0, 10, ally);

    expect(world.stores.owner.eid[projectile]).toBe(ally);
    expect(hasComponent(world.ecs, projectile, EnemyProjectile)).toBe(true);
    expect(hasComponent(world.ecs, projectile, Owner)).toBe(true);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(100);
    expect(entityExists(world.ecs, projectile)).toBe(true);
    expect(world.combatEvents).toHaveLength(0);
  });

  it('damages hostile enemies with player-team enemy projectiles', () => {
    const world = createTestWorld();
    const ally = spawnEnemy(world, 0, 0, 25);
    addComponent(world.ecs, ally, set(Team, { id: TeamId.PLAYER }));
    const hostile = spawnEnemy(world, 0, 0, 25);
    const projectile = spawnEnemyProjectile(world, 0, 0, 0, 0, 10, ally);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[hostile]).toBe(15);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('emits a blocked combat event when player is invincible', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 1, 0, 25);

    // First hit applies damage
    damageSystem(world, collisionSystem(world));
    world.combatEvents.length = 0;

    // Second hit within invincibility window should be blocked
    world.elapsedMs += 100; // less than 250ms invincibility
    damageSystem(world, collisionSystem(world));

    expect(world.combatEvents).toHaveLength(1);
    expect(world.combatEvents[0]).toMatchObject({
      type: 'blocked',
      amount: 0,
      targetType: 'player',
    });
  });
});
