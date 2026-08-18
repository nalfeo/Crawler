import type { GameWorld } from './world.js';
import type { RoomData } from '../shared/map-types.js';

export interface Floor2SettlementAnchor {
  readonly x: number;
  readonly y: number;
}

/**
 * Resolve the generated settlement bar's stable walkable anchor.
 *
 * Floor 2 retags settlement rooms as SAFE after generation, so the persisted
 * settlement room id is the authoritative lookup rather than the room role.
 */
export function resolveFloor2SettlementAnchor(world: GameWorld): Floor2SettlementAnchor | null {
  const floorMap = world.floorMap;
  const settlementRoomId = world.floorExtendedState?.settlement?.settlementRoomId;
  if (!floorMap || settlementRoomId === undefined) {
    return null;
  }

  const room = floorMap.roomGraph.get(settlementRoomId);
  if (!room) {
    return null;
  }
  const best = pickRoomAnchorCell(room);
  if (!best) {
    return null;
  }
  return floorMap.tileToWorld(best.x, best.y);
}

/**
 * The interior cell closest to a room's geometric center — the stable walkable
 * anchor an AI should path to when it wants to be "in" that room.
 *
 * Ties break on lowest y then lowest x so the result is deterministic for a
 * given room regardless of `interiorCells` ordering.
 */
export function pickRoomAnchorCell(room: RoomData): { x: number; y: number } | null {
  const cells = room.interiorCells;
  if (!cells || cells.length === 0) {
    return null;
  }

  const centerX = room.bounds.x + (room.bounds.width - 1) / 2;
  const centerY = room.bounds.y + (room.bounds.height - 1) / 2;
  let best = cells[0]!;
  let bestDistanceSq =
    (best.x - centerX) * (best.x - centerX) + (best.y - centerY) * (best.y - centerY);

  for (let i = 1; i < cells.length; i += 1) {
    const cell = cells[i]!;
    const distanceSq =
      (cell.x - centerX) * (cell.x - centerX) + (cell.y - centerY) * (cell.y - centerY);
    if (
      distanceSq < bestDistanceSq ||
      (distanceSq === bestDistanceSq && (cell.y < best.y || (cell.y === best.y && cell.x < best.x)))
    ) {
      best = cell;
      bestDistanceSq = distanceSq;
    }
  }

  return { x: best.x, y: best.y };
}
