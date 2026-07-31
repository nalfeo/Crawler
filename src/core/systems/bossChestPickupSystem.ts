/**
 * Boss Chest Pickup System — auto-opens physical boss-chest world-objects when
 * the player walks within BOSS_CHEST_RANGE_FT.
 *
 * Each frame:
 * 1. Find the player entity and its position.
 * 2. For every BossChestEntity, check player proximity.
 * 3. If in range: look up the chest record via `world.bossChestEids` reverse map,
 *    call `openBossChest` to transition `available → revealed`, then remove the
 *    entity (the reward presentation is driven by the engine layer polling for
 *    `state === 'revealed'` chests in `world.bossChests`).
 *
 * Runs after movementSystem so positions are up-to-date.
 */
import { entityExists, query, removeEntity } from 'bitecs';
import { Inventory, Player, Position } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';
import { openBossChest } from './bossChestRewards.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';

/**
 * Proximity radius in feet within which the player triggers a boss chest open.
 * 4 ft matches the harvest system's pickup radius — comfortable for manual play
 * and AI navigation while still feeling intentional (not accidental during combat).
 */
const BOSS_CHEST_RANGE_FT = 4.0;

export function bossChestPickupSystem(world: GameWorld): void {
  const playerEntities = query(world.ecs, [Player, Position, Inventory]);
  if (playerEntities.length === 0) return;

  const playerEid = playerEntities[0]!;
  const { position } = world.stores;

  const px = position.x[playerEid] ?? 0;
  const py = position.y[playerEid] ?? 0;

  // Build chestId→eid reverse entries from the sidecar map for cleanup.
  // Iterate the sidecar (chestId→eid) rather than querying ECS to keep the
  // hot path O(numChests) instead of scanning the full entity table.
  for (const [chestId, eid] of world.bossChestEids) {
    if (!entityExists(world.ecs, eid)) {
      // Stale sidecar entry (entity was removed by another path) — clean up.
      world.bossChestEids.delete(chestId);
      continue;
    }

    const cx = position.x[eid] ?? 0;
    const cy = position.y[eid] ?? 0;

    const dx = px - cx;
    const dy = py - cy;
    const distSq = dx * dx + dy * dy;

    if (distSq > BOSS_CHEST_RANGE_FT * BOSS_CHEST_RANGE_FT) continue;

    // Player is in range — attempt to open the chest.
    const result = openBossChest(world, chestId, playerEid);

    if (!result.ok) {
      // grantFailed (e.g. full bag): leave the entity in place so the player can
      // retry after making room. unknownChest / invalidTransition are defensive
      // edge cases — remove the orphan entity to avoid a stuck chest.
      if (result.reason !== 'grantFailed') {
        world.bossChestEids.delete(chestId);
        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
      }
      continue;
    }

    if (result.alreadyClaimed) {
      // Already opened — remove the lingering entity.
      world.bossChestEids.delete(chestId);
      clearEntityStores(world, eid);
      removeEntity(world.ecs, eid);
      continue;
    }

    // Successful open → emit sparkle VFX and remove the world entity.
    pushVfxEvent(world.vfxEvents, {
      kind: 'pickupSparkle',
      x: cx,
      y: cy,
      color: 0xffd700, // gold
    });

    world.bossChestEids.delete(chestId);
    clearEntityStores(world, eid);
    removeEntity(world.ecs, eid);
  }
}
