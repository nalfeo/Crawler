import { addComponent, entityExists, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { BroadcastScore } from '../../src/core/components.js';
import { spawnPlayer, spawnXpGem, spawnGold, spawnDroppedItem } from '../../src/core/helpers.js';
import { getItemIndex } from '../../src/shared/items.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { itemPickupSystem } from '../../src/core/systems/itemPickupSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { recoverStolenGoldAt } from '../../src/core/spawners/pickups.js';

describe('itemPickupSystem', () => {
  it.each([0, 4, 20])('returns stolen gold without minting income (balance %s)', (balance) => {
    const world = createTestWorld({ floor: 2 });
    spawnPlayer(world, 0, 0);
    world.playerGold = balance;
    world.goldLedger.earnedFromDrops = balance;
    const stolen = recoverStolenGoldAt(world, 0.5, 0);
    expect(stolen).toBe(Math.min(10, balance));
    expect(world.playerGold).toBe(balance - stolen);
    expect(world.goldLedger.stolenByEnemies).toBe(stolen);
    expect(world.lootLedger.goldSpawned).toBe(0);
    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);
    itemPickupSystem(world, collisions);
    expect(world.playerGold).toBe(balance);
    expect(world.goldLedger.recoveredStolenGold).toBe(stolen);
    expect(world.goldLedger.earnedFromDrops).toBe(balance);
    expect(world.lootLedger.goldCollected).toBe(0);
    spawnGold(world, 0.5, 0, 3);
    itemPickupSystem(world, collisionSystem(world));
    expect(world.goldLedger.earnedFromDrops).toBe(balance + 3);
  });

  it.each([
    { current: 100, max: 200, expected: 120, consumed: true },
    { current: 195, max: 200, expected: 200, consumed: true },
    { current: 200, max: 200, expected: 200, consumed: false },
    { current: 0, max: 200, expected: 0, consumed: false },
    { current: 10, max: 105, expected: 20.5, consumed: true },
  ])('healing potion: $current/$max -> $expected', ({ current, max, expected, consumed }) => {
    const world = createTestWorld({ floor: 2 });
    world.floorId = 'floor2';
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.current[player] = current;
    world.stores.health.max[player] = max;
    const potion = spawnDroppedItem(world, 0.5, 0, getItemIndex('health-vial'));
    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);
    itemPickupSystem(world, collisions); // stale collision pairs must not heal twice
    expect(world.stores.health.current[player]).toBeCloseTo(expected);
    expect(entityExists(world.ecs, potion)).toBe(!consumed);
  });

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
