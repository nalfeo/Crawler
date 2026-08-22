import { describe, expect, it, beforeEach } from 'vitest';
import { hasComponent, query } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnPlayer, spawnDroppedItem, spawnGold, spawnXpGem } from '../../src/core/helpers.js';
import { DroppedItem, Inventory } from '../../src/core/components.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { itemPickupSystem } from '../../src/core/systems/itemPickupSystem.js';
import { getItemCount, listStaticInventorySlots } from '../../src/shared/inventory.js';
import { getItemByIndex } from '../../src/shared/items.js';
import { PICKUP_SPARKLE_COLORS } from '../../src/shared/vfx-events.js';
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
    spawnDroppedItem(world, 100, 100, 0); // First catalog item
    spawnDroppedItem(world, 100, 100, 20); // Item at index 20

    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);

    const bag = world.inventories.get(playerEid)!;
    expect(listStaticInventorySlots(bag).length).toBe(2);
  });

  it('does not pick up items far away', () => {
    spawnDroppedItem(world, 500, 500, 0); // Far from player at 100,100

    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);

    const bag = world.inventories.get(playerEid)!;
    expect(listStaticInventorySlots(bag).length).toBe(0);
  });

  it('removes dropped items even when item index is invalid', () => {
    spawnDroppedItem(world, 100, 100, 99999);

    const collisions = collisionSystem(world);
    itemPickupSystem(world, collisions);

    const droppedItems = query(world.ecs, [DroppedItem]);
    expect(droppedItems.length).toBe(0);

    const bag = world.inventories.get(playerEid)!;
    expect(listStaticInventorySlots(bag).length).toBe(0);
  });

  describe('pickup sparkle VFX', () => {
    it('emits a gold-tinted sparkle at the gold position on pickup', () => {
      spawnGold(world, 100, 100, 50);

      const collisions = collisionSystem(world);
      itemPickupSystem(world, collisions);

      expect(world.vfxEvents).toHaveLength(1);
      expect(world.vfxEvents[0]).toMatchObject({
        kind: 'pickupSparkle',
        x: 100,
        y: 100,
        color: PICKUP_SPARKLE_COLORS.gold,
      });
    });

    it('emits a gem-tinted sparkle on XP gem pickup', () => {
      spawnXpGem(world, 100, 100, 5);

      const collisions = collisionSystem(world);
      itemPickupSystem(world, collisions);

      expect(world.vfxEvents).toHaveLength(1);
      expect(world.vfxEvents[0]).toMatchObject({
        kind: 'pickupSparkle',
        color: PICKUP_SPARKLE_COLORS.gem,
      });
    });

    it('emits an item-tinted sparkle on dropped-item pickup', () => {
      spawnDroppedItem(world, 100, 100, 0);

      const collisions = collisionSystem(world);
      itemPickupSystem(world, collisions);

      expect(world.vfxEvents).toHaveLength(1);
      expect(world.vfxEvents[0]).toMatchObject({
        kind: 'pickupSparkle',
        color: PICKUP_SPARKLE_COLORS.item,
      });
    });

    it('does not emit a sparkle when nothing is picked up', () => {
      spawnGold(world, 500, 500, 50);

      const collisions = collisionSystem(world);
      itemPickupSystem(world, collisions);

      expect(world.vfxEvents).toHaveLength(0);
    });
  });

  describe('material floater', () => {
    it('emits a material-gain floater when picking up a material dropped item', () => {
      const materialIndex = 0;
      const materialDef = getItemByIndex(materialIndex);
      expect(materialDef).toBeDefined();
      spawnDroppedItem(world, 100, 100, materialIndex);

      itemPickupSystem(world, collisionSystem(world));

      expect(world.floaterEvents).toHaveLength(1);
      expect(world.floaterEvents[0]).toMatchObject({
        kind: 'materialGain',
        x: 100,
        y: 100,
        label: `+1 ${materialDef!.name}`,
      });
    });

    it('does not emit a material-gain floater for non-material dropped items', () => {
      // Index 20 is the first weapon in the catalog.
      spawnDroppedItem(world, 100, 100, 20);

      itemPickupSystem(world, collisionSystem(world));

      expect(world.floaterEvents).toHaveLength(0);
    });
  });
  describe('loot ledger', () => {
    it('counts spawned XP/gold value even when nothing is collected', () => {
      spawnXpGem(world, 500, 500, 7);
      spawnGold(world, 500, 500, 30);

      const collisions = collisionSystem(world);
      itemPickupSystem(world, collisions);

      expect(world.lootLedger).toEqual({
        xpSpawned: 7,
        xpCollected: 0,
        goldSpawned: 30,
        goldCollected: 0,
      });
    });

    it('counts collected XP/gold value on pickup', () => {
      spawnXpGem(world, 100, 100, 7);
      spawnGold(world, 100, 100, 30);
      // Out of reach: spawned but never collected.
      spawnXpGem(world, 500, 500, 5);

      const collisions = collisionSystem(world);
      itemPickupSystem(world, collisions);

      expect(world.lootLedger).toEqual({
        xpSpawned: 12,
        xpCollected: 7,
        goldSpawned: 30,
        goldCollected: 30,
      });
    });

    it('never decrements — counters are cumulative across pickups', () => {
      spawnGold(world, 100, 100, 10);
      itemPickupSystem(world, collisionSystem(world));
      spawnGold(world, 100, 100, 15);
      itemPickupSystem(world, collisionSystem(world));

      expect(world.lootLedger.goldSpawned).toBe(25);
      expect(world.lootLedger.goldCollected).toBe(25);
    });
  });
});
