import { describe, expect, it, beforeEach } from 'vitest';
import { hasComponent, query } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnPlayer, spawnDroppedItem } from '../../src/core/helpers.js';
import { DroppedItem, Inventory } from '../../src/core/components.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { itemPickupSystem } from '../../src/core/systems/itemPickupSystem.js';
import { getItemCount } from '../../src/shared/inventory.js';
import { getItemByIndex } from '../../src/shared/items.js';
import type { GameWorld } from '../../src/core/world.js';

describe('itemPickupSystem', () => {
  let world: GameWorld;
  let playerEid: number;

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
    playerEid = spawnPlayer(world, 100, 100);
  });

  it('player has Inventory component after spawn', () => {
    expect(hasComponent(world.ecs, playerEid, Inventory)).toBe(true);
    expect(world.inventories.has(playerEid)).toBe(true);
  });

  it('picks up a dropped item on collision', () => {
    // Place item at same position as player to guarantee collision
    const itemEid = spawnDroppedItem(world, 100, 100, 0);
    expect(hasComponent(world.ecs, itemEid, DroppedItem)).toBe(true);

    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);

    const bag = world.inventories.get(playerEid)!;
    const itemDef = getItemByIndex(0)!;
    expect(getItemCount(bag, itemDef.id)).toBe(1);
  });

  it('removes the DroppedItem entity after pickup', () => {
    spawnDroppedItem(world, 100, 100, 0);

    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);

    // DroppedItem entities should be gone
    const droppedItems = query(world.ecs, [DroppedItem]);
    expect(droppedItems.length).toBe(0);
  });

  it('stacks multiple pickups of the same item', () => {
    spawnDroppedItem(world, 100, 100, 0);
    spawnDroppedItem(world, 100, 100, 0);

    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);

    const bag = world.inventories.get(playerEid)!;
    const itemDef = getItemByIndex(0)!;
    expect(getItemCount(bag, itemDef.id)).toBe(2);
  });

  it('picks up different item types', () => {
    spawnDroppedItem(world, 100, 100, 0);  // First catalog item
    spawnDroppedItem(world, 100, 100, 20); // Item at index 20

    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);

    const bag = world.inventories.get(playerEid)!;
    expect(bag.slots.length).toBe(2);
  });

  it('does not pick up items far away', () => {
    spawnDroppedItem(world, 500, 500, 0); // Far from player at 100,100

    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);

    const bag = world.inventories.get(playerEid)!;
    expect(bag.slots.length).toBe(0);
  });
});
