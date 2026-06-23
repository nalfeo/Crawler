import { addComponent, entityExists, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { BroadcastScore } from '../../src/core/components.js';
import { spawnPlayer, spawnXpGem, spawnGold } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { itemPickupSystem } from '../../src/core/systems/itemPickupSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('itemPickupSystem', () => {
  it('picks up gold and adds to playerGold', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const gold = spawnGold(world, 0.5, 0, 10);

    itemPickupSystem(world, collisionSystem(world));

    expect(entityExists(world.ecs, gold)).toBe(false);
    expect(world.playerGold).toBe(10);
  });

  it('picks up XP gems and adds to score + playerLevel', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const gem = spawnXpGem(world, 0.5, 0, 7);

    addComponent(world.ecs, player, set(BroadcastScore, { current: 0 }));
    itemPickupSystem(world, collisionSystem(world));

    expect(entityExists(world.ecs, gem)).toBe(false);
    expect(world.stores.broadcastScore.current[player]).toBe(7);
    expect(world.playerLevel.xp).toBe(7);
  });

  it('accumulates gold from multiple pickups', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    spawnGold(world, 0.5, 0, 5);
    spawnGold(world, 0.75, 0, 3);

    itemPickupSystem(world, collisionSystem(world));

    expect(world.playerGold).toBe(8);
  });
});
