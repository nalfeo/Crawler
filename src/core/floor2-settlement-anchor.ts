import type { GameWorld } from './world.js';

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
  const cells = room?.interiorCells;
  if (!room || !cells || cells.length === 0) {
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

  return floorMap.tileToWorld(best.x, best.y);
}
