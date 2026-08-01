/**
 * Item Pickup System — handles pickup of Gold, XpGem, and DroppedItem entities
 * on Player collision.
 *
 * Runs after the collision system. For each collision pair where one entity is
 * a Player and the other is a pickup entity:
 * - Gold: increments world.playerGold and removes the entity
 * - XpGem: adds XP/score and removes the entity
 * - DroppedItem: adds item to player's InventoryBag and removes the entity
 */
import { entityExists, hasComponent, removeEntity } from 'bitecs';
import { DroppedItem, Gold, Inventory, Player, XpGem } from '../components.js';
import type { GameWorld } from '../world.js';
import type { CollisionResult } from './collisionSystem.js';
import { addItem } from '../../shared/inventory.js';
import { getItemByIndex } from '../../shared/items.js';
import { PICKUP_SPARKLE_COLORS, pushVfxEvent, type PickupKind } from '../../shared/vfx-events.js';
import { recordCollectedXp } from '../xp-collection-telemetry.js';

/** Queue a cosmetic collect-sparkle at a pickup's position (render-only). */
function emitPickupSparkle(world: GameWorld, eid: number, kind: PickupKind): void {
  pushVfxEvent(world.vfxEvents, {
    kind: 'pickupSparkle',
    x: world.stores.position.x[eid] ?? 0,
    y: world.stores.position.y[eid] ?? 0,
    color: PICKUP_SPARKLE_COLORS[kind],
  });
}

export function itemPickupSystem(world: GameWorld, collisions: CollisionResult): void {
  for (const pair of collisions.pairs) {
    if (!entityExists(world.ecs, pair.a) || !entityExists(world.ecs, pair.b)) {
      continue;
    }

    let playerEid: number | undefined;
    let otherEid: number | undefined;

    if (hasComponent(world.ecs, pair.a, Player)) {
      playerEid = pair.a;
      otherEid = pair.b;
    } else if (hasComponent(world.ecs, pair.b, Player)) {
      playerEid = pair.b;
      otherEid = pair.a;
    }

    if (playerEid === undefined || otherEid === undefined) continue;

    // Gold pickup
    if (hasComponent(world.ecs, otherEid, Gold)) {
      const goldValue = world.stores.gold.value[otherEid] ?? 0;
      world.playerGold += goldValue;
      emitPickupSparkle(world, otherEid, 'gold');
      removeEntity(world.ecs, otherEid);
      continue;
    }

    // XP gem pickup
    if (hasComponent(world.ecs, otherEid, XpGem)) {
      const gemValue = world.stores.xpGem.value[otherEid] ?? 0;
      const currentScore = world.stores.broadcastScore.current[playerEid] ?? 0;
      world.stores.broadcastScore.current[playerEid] = currentScore + gemValue;
      world.playerLevel.xp += gemValue;
      recordCollectedXp(world, gemValue);
      emitPickupSparkle(world, otherEid, 'gem');
      removeEntity(world.ecs, otherEid);
      continue;
    }

    // Dropped item pickup
    if (
      hasComponent(world.ecs, otherEid, DroppedItem) &&
      hasComponent(world.ecs, playerEid, Inventory)
    ) {
      const bag = world.inventories.get(playerEid);
      if (!bag) continue;

      const itemIndex = world.stores.droppedItem.itemIndex[otherEid] ?? 0;
      const def = getItemByIndex(itemIndex);
      if (def) {
        addItem(bag, def.id, 1);
      }
      emitPickupSparkle(world, otherEid, 'item');
      removeEntity(world.ecs, otherEid);
    }
  }
}
