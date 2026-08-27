import type { GameWorld } from './world.js';
import { RoomRole, type RoomData } from '../shared/map-types.js';
import { getWorldFloorBehavior } from './floor-behavior.js';
import { pickRoomAnchorCell, resolveFloor2SettlementAnchor } from './floor2-settlement-anchor.js';

export interface SafeAnchor {
  readonly x: number;
  readonly y: number;
}

/**
 * Resolve the walkable anchor of the safe context nearest the given position.
 *
 * This generalizes {@link resolveFloor2SettlementAnchor} from "the Floor 2
 * settlement" to "wherever the player can legitimately open the equipment,
 * inventory, achievement and ability panels". The AI needs it because those
 * panels are safe-context gated for the AI exactly as they are for a human, so
 * a chest reward it is carrying is unusable until it stands in one — and on
 * Floor 1 there is no settlement to route to.
 *
 * Resolution order:
 *  1. The Floor 2 settlement anchor when one exists (settlement rooms are
 *     retagged SAFE after generation, so the persisted room id stays
 *     authoritative and Floor 2 routing is bit-for-bit unchanged).
 *  2. Otherwise the nearest safe room by straight-line distance to its anchor
 *     cell — including the spawn room on floors whose behavior marks it safe.
 *
 * Straight-line distance (not path length) is deliberate: this only picks the
 * routing *goal*; the caller then paths to it with the real A* and its own
 * reachability handling. Ties break on the lowest anchor tile so the choice is
 * deterministic.
 */
export function resolveNearestSafeAnchor(
  world: GameWorld,
  playerX: number,
  playerY: number,
): SafeAnchor | null {
  const settlement = resolveFloor2SettlementAnchor(world);
  if (settlement) {
    return settlement;
  }

  const floorMap = world.floorMap;
  if (!floorMap) {
    return null;
  }

  const rooms: RoomData[] = [];
  if (getWorldFloorBehavior(world).spawnRoomIsSafe) {
    const spawnRoom = floorMap.spawnRoom;
    if (spawnRoom) {
      rooms.push(spawnRoom);
    }
  }
  for (const room of floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE)) {
    if (!rooms.includes(room)) {
      rooms.push(room);
    }
  }
  // Arenas that became safe during the run (a cleared boss room) are real safe
  // destinations too, so retreat routing must be able to pick the one next
  // door instead of walking back to the authored safe room. Kept in sync with
  // `isPointInSafeSpace`, including the per-floor id scoping.
  if (world.clearedSafeRoomMap === floorMap) {
    for (const roomId of world.clearedSafeRoomIds) {
      const room = floorMap.roomGraph.get(roomId);
      if (room && !rooms.includes(room)) {
        rooms.push(room);
      }
    }
  }
  if (rooms.length === 0) {
    return null;
  }

  let best: SafeAnchor | null = null;
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestTileX = Number.POSITIVE_INFINITY;
  let bestTileY = Number.POSITIVE_INFINITY;
  for (const room of rooms) {
    // Generated rooms carry `interiorCells` (irregular shapes); simple
    // rectangular rooms may not, and falling back to the bounds center keeps
    // them routable instead of silently unroutable.
    const cell = pickRoomAnchorCell(room) ?? {
      x: Math.floor(room.bounds.x + (room.bounds.width - 1) / 2),
      y: Math.floor(room.bounds.y + (room.bounds.height - 1) / 2),
    };
    const anchor = floorMap.tileToWorld(cell.x, cell.y);
    const distanceSq =
      (anchor.x - playerX) * (anchor.x - playerX) + (anchor.y - playerY) * (anchor.y - playerY);
    const closer = distanceSq < bestDistanceSq;
    const tieBreak =
      distanceSq === bestDistanceSq &&
      (cell.y < bestTileY || (cell.y === bestTileY && cell.x < bestTileX));
    if (closer || tieBreak) {
      best = anchor;
      bestDistanceSq = distanceSq;
      bestTileX = cell.x;
      bestTileY = cell.y;
    }
  }
  return best;
}
