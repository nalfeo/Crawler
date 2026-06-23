import { addComponent, entityExists, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { BroadcastScore, Position, Projectile, Sprite } from '../../src/core/components.js';
import { createEntity, spawnEnemy, spawnPlayer, spawnXpGem } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('damageSystem', () => {
  it('reduces enemy health when a projectile hits', () => {
    const world = createTestWorld();
    const projectile = createEntity(world);
    const enemy = spawnEnemy(world, 1, 0, 25);

    addComponent(world.ecs, projectile, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, projectile, set(Sprite, { textureId: 0, width: 8, height: 8 }));
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

  it('xp gem collection is handled by itemPickupSystem (not damageSystem)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const gem = spawnXpGem(world, 4, 0, 7);

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
