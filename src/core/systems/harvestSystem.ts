/**
 * Harvest System — lets the player collect resource nodes by standing on them.
 *
 * Each frame:
 * 1. Find the player entity and its position.
 * 2. For every Harvestable node, check if the player is within HARVEST_RANGE_FT.
 * 3. If in range: increment progressMs by GAME.DELTA_MS.
 *    - When progressMs ≥ durationMs: add the item to the player's inventory,
 *      remove the node entity, and emit a pickupSparkle VFX event.
 * 4. If out of range but previously harvesting: reset progressMs to 0.
 *
 * Runs after movementSystem so positions are up-to-date.
 */
import { entityExists, query, removeEntity } from 'bitecs';
import { Harvestable, Inventory, Player, Position } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';
import { GAME } from '../../shared/constants.js';
import { addItem } from '../../shared/inventory.js';
import { getItemById } from '../../shared/items.js';
import { pushFloaterEvent } from '../../shared/floater-events.js';
import { getHarvestableDefByIndex } from '../../shared/harvestableDefs.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';

/**
 * Proximity radius in feet within which the player triggers harvesting.
 * 4 ft from center gives a comfortable pickup radius that is forgiving to
 * both manual play and AI navigation without feeling accidental.
 */
export const HARVEST_RANGE_FT = 4.0;

export function harvestSystem(world: GameWorld): void {
  // Locate the player — there is exactly one Player entity per world.
  const playerEntities = query(world.ecs, [Player, Position, Inventory]);
  if (playerEntities.length === 0) return;

  const playerEid = playerEntities[0]!;
  const { position, harvestable } = world.stores;

  const px = position.x[playerEid] ?? 0;
  const py = position.y[playerEid] ?? 0;

  const nodes = query(world.ecs, [Harvestable, Position]);

  for (const eid of Array.from(nodes)) {
    if (!entityExists(world.ecs, eid)) continue;

    const nx = position.x[eid] ?? 0;
    const ny = position.y[eid] ?? 0;

    const dx = px - nx;
    const dy = py - ny;
    const distSq = dx * dx + dy * dy;
    const inRange = distSq <= HARVEST_RANGE_FT * HARVEST_RANGE_FT;

    if (inRange) {
      // Advance harvest progress.
      const prev = harvestable.progressMs[eid] ?? 0;
      const duration = harvestable.durationMs[eid] ?? 1;
      const next = prev + GAME.DELTA_MS;
      harvestable.progressMs[eid] = next;
      harvestable.harvesterEid[eid] = playerEid;

      if (next >= duration) {
        // Harvest complete — add item to player inventory.
        const defIndex = harvestable.defIndex[eid] ?? 0;
        const def = getHarvestableDefByIndex(defIndex);
        if (def) {
          const itemDef = getItemById(def.itemId);
          if (itemDef) {
            const bag = world.inventories.get(playerEid);
            if (bag) {
              addItem(bag, itemDef.id, 1);
              pushFloaterEvent(world.floaterEvents, {
                kind: 'materialGain',
                x: nx,
                y: ny,
                label: `+1 ${itemDef.name}`,
              });
            }
          }
        }

        // Emit sparkle VFX at the node position.
        pushVfxEvent(world.vfxEvents, {
          kind: 'pickupSparkle',
          x: nx,
          y: ny,
          color: 0x66ffaa,
        });

        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
      }
    } else {
      // Player moved out of range — reset any partial progress.
      if ((harvestable.progressMs[eid] ?? 0) > 0) {
        harvestable.progressMs[eid] = 0;
        harvestable.harvesterEid[eid] = 0;
      }
    }
  }
}
