/**
 * Item Pickup System — auto-picks up DroppedItem entities on Player collision.
 *
 * Runs after the collision system. For each collision pair where one entity is
 * a Player with Inventory and the other is a DroppedItem, the item is added to
 * the player's InventoryBag and the DroppedItem entity is removed.
 */
import { entityExists, hasComponent, removeEntity } from 'bitecs';
import { DroppedItem, Inventory, Player } from '../components.js';
import type { GameWorld } from '../world.js';
import type { CollisionResult } from './collisionSystem.js';
import { addItem } from '../../shared/inventory.js';
import { getItemByIndex } from '../../shared/items.js';

export function itemPickupSystem(world: GameWorld, collisions: CollisionResult): void {
  for (const pair of collisions.pairs) {
    if (!entityExists(world.ecs, pair.a) || !entityExists(world.ecs, pair.b)) {
      continue;
    }

    let playerEid: number | undefined;
    let itemEid: number | undefined;

    if (
      hasComponent(world.ecs, pair.a, Player) &&
      hasComponent(world.ecs, pair.a, Inventory) &&
      hasComponent(world.ecs, pair.b, DroppedItem)
    ) {
      playerEid = pair.a;
      itemEid = pair.b;
    } else if (
      hasComponent(world.ecs, pair.b, Player) &&
      hasComponent(world.ecs, pair.b, Inventory) &&
      hasComponent(world.ecs, pair.a, DroppedItem)
    ) {
      playerEid = pair.b;
      itemEid = pair.a;
    }

    if (playerEid === undefined || itemEid === undefined) continue;

    const bag = world.inventories.get(playerEid);
    if (!bag) continue;

    const itemIndex = world.stores.droppedItem.itemIndex[itemEid] ?? 0;
    const def = getItemByIndex(itemIndex);
    if (def) {
      addItem(bag, def.id, 1);
    }
    removeEntity(world.ecs, itemEid);
  }
}
