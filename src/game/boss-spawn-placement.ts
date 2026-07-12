import type { FloorMap } from '../core/map/FloorMap.js';
import { floodFill } from '../core/map/grid-utils.js';
import type { RoomData } from '../shared/map-types.js';

export interface BossSpawnPlacement {
  readonly tile: { readonly x: number; readonly y: number };
  readonly position: { readonly x: number; readonly y: number };
  readonly playerDistanceFt: number;
  readonly nearestDoorDistanceFt: number | null;
  readonly safetyFt: number;
  readonly preferredMinimumSatisfied: boolean;
}

interface BossSpawnCandidate extends BossSpawnPlacement {
  readonly centerDistanceSq: number;
}

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

function isBetterCandidate(
  candidate: BossSpawnCandidate,
  incumbent: BossSpawnCandidate | null,
): boolean {
  if (incumbent === null) return true;
  if (candidate.safetyFt !== incumbent.safetyFt) {
    return candidate.safetyFt > incumbent.safetyFt;
  }
  if (candidate.centerDistanceSq !== incumbent.centerDistanceSq) {
    return candidate.centerDistanceSq < incumbent.centerDistanceSq;
  }
  if (candidate.tile.y !== incumbent.tile.y) {
    return candidate.tile.y < incumbent.tile.y;
  }
  return candidate.tile.x < incumbent.tile.x;
}

/**
 * Select the safest reachable tile inside a boss room after its doors seal.
 *
 * The primary score maximizes the smaller of the player gap and the nearest
 * entry-door gap. Declared room doors are blocked regardless of their current
 * tile state because the two Floor 1 encounters close doors on opposite sides
 * of boss creation.
 *
 * Reachability uses structural semantics only — exact room membership,
 * declared doors blocked, and `tileMap.isPassable(tx,ty)`. Dynamic barrier
 * overlays are intentionally excluded so a barrier sitting on the player tile
 * at the moment of encounter start cannot make the flood-fill abort.
 */
export function selectBossSpawnPlacement(
  floorMap: FloorMap,
  room: RoomData,
  playerPosition: Readonly<{ x: number; y: number }>,
  preferredMinimumFt: number,
): BossSpawnPlacement {
  if (!Number.isFinite(preferredMinimumFt) || preferredMinimumFt < 0) {
    throw new Error(
      `Boss spawn preferred minimum must be non-negative; got ${preferredMinimumFt}.`,
    );
  }

  const playerTile = floorMap.worldToTile(playerPosition.x, playerPosition.y);
  const blockedDoors = new Set(room.doors.map((door) => tileKey(door.x, door.y)));
  // Use structural passability only (tile flags + room membership + declared
  // door blocking). Dynamic barrier overlays must not affect spawn-graph
  // reachability — a barrier on the player tile would otherwise cause the
  // flood-fill seed to be impassable and crash encounter start.
  const isReachableRoomTile = (idx: number): boolean => {
    const tx = idx % floorMap.width;
    const ty = Math.floor(idx / floorMap.width);
    if (blockedDoors.has(tileKey(tx, ty))) return false;
    if (floorMap.roomGraph.getRoomAt(tx, ty) !== room.id) return false;
    return floorMap.tileMap.isPassable(tx, ty);
  };

  const playerIndex = playerTile.y * floorMap.width + playerTile.x;
  const reachable = floodFill(playerIndex, floorMap.width, floorMap.height, isReachableRoomTile);
  if (reachable[playerIndex] !== 1) {
    throw new Error(
      `Boss spawn player tile (${playerTile.x},${playerTile.y}) is not a reachable interior tile of room ${room.id}.`,
    );
  }

  const roomCenterX = room.bounds.x + (room.bounds.width - 1) / 2;
  const roomCenterY = room.bounds.y + (room.bounds.height - 1) / 2;
  let best: BossSpawnCandidate | null = null;

  const maxX = room.bounds.x + room.bounds.width;
  const maxY = room.bounds.y + room.bounds.height;
  for (let ty = room.bounds.y; ty < maxY; ty += 1) {
    for (let tx = room.bounds.x; tx < maxX; tx += 1) {
      const idx = ty * floorMap.width + tx;
      if (reachable[idx] !== 1 || floorMap.tileMap.isDoor(tx, ty)) continue;

      const position = floorMap.tileToWorld(tx, ty);
      const playerDistanceFt = Math.hypot(
        position.x - playerPosition.x,
        position.y - playerPosition.y,
      );
      let nearestDoorDistanceFt: number | null = null;
      for (const door of room.doors) {
        const doorPosition = floorMap.tileToWorld(door.x, door.y);
        const distance = Math.hypot(position.x - doorPosition.x, position.y - doorPosition.y);
        if (nearestDoorDistanceFt === null || distance < nearestDoorDistanceFt) {
          nearestDoorDistanceFt = distance;
        }
      }
      const safetyFt =
        nearestDoorDistanceFt === null
          ? playerDistanceFt
          : Math.min(playerDistanceFt, nearestDoorDistanceFt);
      const dx = tx - roomCenterX;
      const dy = ty - roomCenterY;
      const candidate: BossSpawnCandidate = {
        tile: { x: tx, y: ty },
        position,
        playerDistanceFt,
        nearestDoorDistanceFt,
        safetyFt,
        preferredMinimumSatisfied: safetyFt >= preferredMinimumFt,
        centerDistanceSq: dx * dx + dy * dy,
      };
      if (isBetterCandidate(candidate, best)) {
        best = candidate;
      }
    }
  }

  if (best === null) {
    throw new Error(
      `Boss room ${room.id} has no legal spawn tile reachable from player tile (${playerTile.x},${playerTile.y}).`,
    );
  }

  return {
    tile: best.tile,
    position: best.position,
    playerDistanceFt: best.playerDistanceFt,
    nearestDoorDistanceFt: best.nearestDoorDistanceFt,
    safetyFt: best.safetyFt,
    preferredMinimumSatisfied: best.preferredMinimumSatisfied,
  };
}
