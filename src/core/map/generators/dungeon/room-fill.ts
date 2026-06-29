/**
 * Special-room fill and wall operations for the dungeon generator.
 *
 * - `sealSpecialRoomPerimeters` — wall off stray openings on SAFE/BOSS_STAIR rooms.
 * - `buildSpecialRoomWalls` — collect perimeter tiles to protect from carving.
 * - `paintRoomFloor` — repaint a room's interior floor with a terrain type.
 *
 * Extracted from DungeonGenerator.ts (behavior-preserving split).
 */

import { TilePresets, TileFlags, TerrainType, RoomRole } from '../../../../shared/map-types';
import { TileMap } from '../../TileMap';
import { RoomGraph } from '../../RoomGraph';

/**
 * Seal the perimeter of SAFE and BOSS_STAIR rooms by converting any passable
 * non-door tile on their boundary to a wall. rot-js can place corridor tiles at
 * positions that overlap the 1-tile padding of adjacent room bounds, creating
 * unintended secondary openings before variety post-processing even runs. This
 * pass guarantees the perimeter is walls + doors from the outset.
 *
 * For connectivity testing purposes, locked doors are treated as pathable — so
 * sealing the boss room here does not create unreachable areas; the room is
 * always reachable via its designated door tiles.
 */
export function sealSpecialRoomPerimeters(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
): void {
  for (const room of roomGraph.getAll()) {
    if (room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR) continue;
    const { x, y, width, height } = room.bounds;

    // Collect door tile indices so we never seal an intentional opening.
    const doorIdxSet = new Set(room.doors.map((d) => d.y * w + d.x));

    const seal = (idx: number): void => {
      if (doorIdxSet.has(idx)) return;
      const flags = tileMap.flags[idx]!;
      if ((flags & TileFlags.PASSABLE) !== 0 && (flags & TileFlags.DOOR) === 0) {
        tileMap.flags[idx] = TilePresets.WALL;
        terrain[idx] = TerrainType.STONE_WALL;
      }
    };

    for (let tx = x; tx < x + width; tx++) {
      seal(y * w + tx);
      seal((y + height - 1) * w + tx);
    }
    for (let ty = y + 1; ty < y + height - 1; ty++) {
      seal(ty * w + x);
      seal(ty * w + (x + width - 1));
    }
  }
}

/**
 * Return the set of tile indices that form the perimeter walls of SAFE and
 * BOSS_STAIR rooms. These tiles are off-limits to corridor widening and diagonal
 * shortcut carving so that special rooms remain fully walled with only their
 * door tiles as openings. No tunnel may bypass a boss room's walls or doors.
 *
 * For connectivity testing, locked doors are considered pathable — so protecting
 * these perimeters never creates unreachable areas; every special room is
 * reachable via its designated door tiles.
 */
export function buildSpecialRoomWalls(roomGraph: RoomGraph, w: number): ReadonlySet<number> {
  const walls = new Set<number>();
  for (const room of roomGraph.getAll()) {
    if (room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR) continue;
    const { x, y, width, height } = room.bounds;
    // Top and bottom rows
    for (let tx = x; tx < x + width; tx++) {
      walls.add(y * w + tx);
      walls.add((y + height - 1) * w + tx);
    }
    // Left and right columns (exclude corners already added above)
    for (let ty = y + 1; ty < y + height - 1; ty++) {
      walls.add(ty * w + x);
      walls.add(ty * w + (x + width - 1));
    }
  }
  return walls;
}

/** Repaint interior floor tiles of a room with a given terrain type. */
export function paintRoomFloor(
  roomId: number,
  roomGraph: RoomGraph,
  mapWidth: number,
  terrain: Uint8Array,
  terrainType: TerrainType,
): void {
  const room = roomGraph.get(roomId);
  if (!room) return;
  const { x, y, width, height } = room.bounds;
  // Interior = 1 tile inset from bounding walls
  for (let ty = y + 1; ty < y + height - 1; ty++) {
    for (let tx = x + 1; tx < x + width - 1; tx++) {
      const idx = ty * mapWidth + tx;
      if (terrain[idx] === TerrainType.STONE_FLOOR) {
        terrain[idx] = terrainType;
      }
    }
  }
}
