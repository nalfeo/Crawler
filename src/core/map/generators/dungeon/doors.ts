/**
 * Door helpers for the dungeon generator.
 *
 * Pure tile-level operations on door placement and access:
 * - `getDoorSide` — classify which wall a door sits on.
 * - `ensureDoorAccess` — guarantee each door has a passable interior-adjacent tile.
 * - `pruneInaccessibleDoors` — drop door markers with no passable interior side.
 * - `expandDoorsForWideCorridors` — add flanking doors where wide corridors meet
 *   special-room walls.
 *
 * Extracted from DungeonGenerator.ts (behavior-preserving split). This is a leaf
 * module: it depends only on shared map types, TileMap, and RoomGraph.
 */

import type { DoorLocation, RoomBounds } from '../../../../shared/map-types';
import { TilePresets, TileFlags, TerrainType, RoomRole } from '../../../../shared/map-types';
import { TileMap } from '../../TileMap';
import { RoomGraph } from '../../RoomGraph';

export type RoomDoorSide = 'left' | 'right' | 'top' | 'bottom';

export function getDoorSide(bounds: RoomBounds, door: DoorLocation): RoomDoorSide | null {
  if (door.x === bounds.x) return 'left';
  if (door.x === bounds.x + bounds.width - 1) return 'right';
  if (door.y === bounds.y) return 'top';
  if (door.y === bounds.y + bounds.height - 1) return 'bottom';
  return null;
}

export function expandDoorsForWideCorridors(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  widenedCorridorTiles: ReadonlySet<number>,
): void {
  const widenedCorridorTouchesDoorway = (x: number, y: number): boolean =>
    tileMap.inBounds(x, y) && widenedCorridorTiles.has(y * w + x);
  const corridorContinues = (x: number, y: number): boolean =>
    tileMap.inBounds(x, y) && terrain[y * w + x] === TerrainType.CORRIDOR;

  const carveInteriorTile = (idx: number): void => {
    if ((tileMap.flags[idx]! & TileFlags.PASSABLE) !== 0) return;
    tileMap.flags[idx] = TilePresets.FLOOR;
    terrain[idx] = TerrainType.STONE_FLOOR;
  };

  for (const room of roomGraph.getAll()) {
    if (room.role === RoomRole.NORMAL) {
      continue;
    }
    const { bounds } = room;
    const doorKeys = new Set(room.doors.map((door) => `${door.x},${door.y}`));
    const addedDoors: DoorLocation[] = [];

    const maybeAddDoor = (
      doorX: number,
      doorY: number,
      outsideX: number,
      outsideY: number,
      forwardX: number,
      forwardY: number,
      insideX: number,
      insideY: number,
    ): void => {
      const key = `${doorX},${doorY}`;
      if (
        doorKeys.has(key) ||
        !widenedCorridorTouchesDoorway(outsideX, outsideY) ||
        !corridorContinues(forwardX, forwardY)
      ) {
        return;
      }
      if (!tileMap.inBounds(doorX, doorY) || !tileMap.inBounds(insideX, insideY)) {
        return;
      }
      const isCorner =
        (doorX === bounds.x || doorX === bounds.x + bounds.width - 1) &&
        (doorY === bounds.y || doorY === bounds.y + bounds.height - 1);
      if (isCorner) {
        return;
      }
      const idx = doorY * w + doorX;
      if ((tileMap.flags[idx]! & TileFlags.DOOR) !== 0) {
        return;
      }
      carveInteriorTile(insideY * w + insideX);
      tileMap.flags[idx] = TilePresets.DOOR_CLOSED;
      terrain[idx] = TerrainType.DOOR;
      addedDoors.push({ x: doorX, y: doorY, connectsTo: -1 });
      doorKeys.add(key);
    };

    for (const door of room.doors) {
      const side = getDoorSide(room.bounds, door);
      if (side === null) continue;

      switch (side) {
        case 'left':
          maybeAddDoor(
            door.x,
            door.y - 1,
            door.x - 1,
            door.y - 1,
            door.x - 2,
            door.y - 1,
            door.x + 1,
            door.y - 1,
          );
          maybeAddDoor(
            door.x,
            door.y + 1,
            door.x - 1,
            door.y + 1,
            door.x - 2,
            door.y + 1,
            door.x + 1,
            door.y + 1,
          );
          break;
        case 'right':
          maybeAddDoor(
            door.x,
            door.y - 1,
            door.x + 1,
            door.y - 1,
            door.x + 2,
            door.y - 1,
            door.x - 1,
            door.y - 1,
          );
          maybeAddDoor(
            door.x,
            door.y + 1,
            door.x + 1,
            door.y + 1,
            door.x + 2,
            door.y + 1,
            door.x - 1,
            door.y + 1,
          );
          break;
        case 'top':
          maybeAddDoor(
            door.x - 1,
            door.y,
            door.x - 1,
            door.y - 1,
            door.x - 1,
            door.y - 2,
            door.x - 1,
            door.y + 1,
          );
          maybeAddDoor(
            door.x + 1,
            door.y,
            door.x + 1,
            door.y - 1,
            door.x + 1,
            door.y - 2,
            door.x + 1,
            door.y + 1,
          );
          break;
        case 'bottom':
          maybeAddDoor(
            door.x - 1,
            door.y,
            door.x - 1,
            door.y + 1,
            door.x - 1,
            door.y + 2,
            door.x - 1,
            door.y - 1,
          );
          maybeAddDoor(
            door.x + 1,
            door.y,
            door.x + 1,
            door.y + 1,
            door.x + 1,
            door.y + 2,
            door.x + 1,
            door.y - 1,
          );
          break;
      }
    }

    if (addedDoors.length > 0) {
      Object.assign(room, { doors: [...room.doors, ...addedDoors] });
    }
  }
}

/**
 * For each door, guarantee the immediately adjacent interior tile is passable.
 * This repairs any case where room reshaping accidentally blocked a doorway.
 */
export function ensureDoorAccess(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  doors: readonly DoorLocation[],
): void {
  for (const door of doors) {
    for (const [nx, ny] of [
      [door.x - 1, door.y],
      [door.x + 1, door.y],
      [door.x, door.y - 1],
      [door.x, door.y + 1],
    ] as [number, number][]) {
      // Must be strictly inside the room bounds (interior tile)
      if (nx > rx && nx < rx + rw - 1 && ny > ry && ny < ry + rh - 1) {
        const idx = ny * w + nx;
        if ((tileMap.flags[idx]! & TileFlags.PASSABLE) === 0) {
          terrain[idx] = TerrainType.STONE_FLOOR;
          tileMap.flags[idx] = TilePresets.FLOOR;
        }
      }
    }
  }
}

/**
 * Remove door markers that no longer have any passable interior-adjacent tile.
 * This can happen after reachability culling seals isolated room interiors.
 */
export function pruneInaccessibleDoors(
  roomGraph: RoomGraph,
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
): void {
  for (const room of roomGraph.getAll()) {
    const keptDoors: DoorLocation[] = [];
    for (const door of room.doors) {
      const side = getDoorSide(room.bounds, door);
      const inward: [number, number] =
        side === 'left'
          ? [door.x + 1, door.y]
          : side === 'right'
            ? [door.x - 1, door.y]
            : side === 'top'
              ? [door.x, door.y + 1]
              : [door.x, door.y - 1];
      const [ix, iy] = inward;
      const hasInteriorAccess =
        ix > room.bounds.x &&
        ix < room.bounds.x + room.bounds.width - 1 &&
        iy > room.bounds.y &&
        iy < room.bounds.y + room.bounds.height - 1 &&
        tileMap.isPassable(ix, iy);
      if (hasInteriorAccess) {
        keptDoors.push(door);
        continue;
      }
      const idx = door.y * w + door.x;
      tileMap.flags[idx] = TilePresets.WALL;
      terrain[idx] = TerrainType.STONE_WALL;
    }
    Object.assign(room, { doors: keptDoors });
  }
}
