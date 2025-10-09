/**
 * Special-room sealing — generic, deterministic perimeter hardening for rooms
 * that must not be tunnelled into (safe rooms, boss rooms, objective rooms).
 *
 * Procedural corridors are carved between room *centres*, so they regularly clip
 * the bounding-box perimeter of a room at non-door tiles. For an ordinary combat
 * room that is harmless, but for a *special* room (a safe refuge or a quest/boss
 * arena) every such gap is a breach an enemy can tunnel through. The generator
 * already seals the one SAFE + one BOSS_STAIR room it picks (and deliberately
 * picks rooms whose perimeters are sealable). Floors that designate *additional*
 * special rooms after generation — Floor 1 tags the welcome office, shop and
 * spell-broker SAFE, and gates the slime-rat quest room — need this pass to get
 * the same guarantee.
 *
 * Sealing rule (per room):
 *   - Wall every passable, non-door perimeter tile ("gap")…
 *   - …unless walling it would strand a region that is currently reachable from
 *     the player spawn. Such *load-bearing* gaps are converted to closed doors
 *     instead, so the room is still fully enclosed (walls + doors only) while the
 *     stranded region stays reachable (a closed door auto-opens for the player
 *     and counts as pathable for connectivity). Converted doors are appended to
 *     the room's `doors` list so downstream door gating/locking picks them up.
 *
 * This module is pure (no ECS / rendering imports) and deterministic.
 */

import {
  RoomRole,
  TerrainType,
  TileFlags,
  TilePresets,
  type DoorLocation,
  type RoomBounds,
  type RoomData,
} from '../../shared/map-types.js';
import type { FloorMap } from './FloorMap.js';
import { floodFill, indexToCoords } from './grid-utils.js';

/** Roles that are treated as "special" (and therefore sealed) by default. */
export const DEFAULT_SPECIAL_ROOM_ROLES: readonly RoomRole[] = [RoomRole.SAFE, RoomRole.BOSS_STAIR];

/** Outcome of sealing a single room's perimeter. */
export interface SealRoomResult {
  /** Tile indices converted from a gap to solid wall. */
  readonly walledTiles: readonly number[];
  /** Doors created from load-bearing gaps that could not be safely walled. */
  readonly addedDoors: readonly DoorLocation[];
}

export interface SealSpecialRoomsOptions {
  /** Roles to seal. Defaults to {@link DEFAULT_SPECIAL_ROOM_ROLES}. */
  readonly roles?: readonly RoomRole[];
  /**
   * Extra room ids to seal regardless of role — e.g. an objective/mini-boss room
   * that is not tagged with a special {@link RoomRole}.
   */
  readonly extraRoomIds?: Iterable<number>;
  /** Room ids to explicitly skip — the "told NOT to seal" opt-out. */
  readonly skipRoomIds?: ReadonlySet<number>;
}

/**
 * Restore a room's full rectangular interior to passable floor tiles. Use when a
 * reserved/special room must keep its full footprint instead of inheriting
 * variety-carved interior walls from a generic room pass.
 */
export function restoreRoomInterior(
  tileFlags: Uint8Array,
  terrain: Uint8Array,
  mapWidth: number,
  room: { bounds: RoomBounds },
  floorTerrain: TerrainType = TerrainType.STONE_FLOOR,
): void {
  const { x, y, width, height } = room.bounds;
  for (let ty = y + 1; ty < y + height - 1; ty += 1) {
    for (let tx = x + 1; tx < x + width - 1; tx += 1) {
      const idx = ty * mapWidth + tx;
      if ((tileFlags[idx]! & TileFlags.DOOR) !== 0) continue;
      tileFlags[idx] = TilePresets.FLOOR;
      terrain[idx] = floorTerrain;
    }
  }
}

/**
 * Seal a single room's perimeter. Walls every breach that can be walled without
 * stranding a spawn-reachable region; converts the remaining (load-bearing)
 * breaches to closed doors. Idempotent: a fully-walled room yields no changes.
 */
export function sealRoomPerimeter(floorMap: FloorMap, room: RoomData): SealRoomResult {
  const w = floorMap.width;
  const h = floorMap.height;
  const flags = floorMap.tileMap.flags;
  const terrain = floorMap.terrain;
  const { x, y, width, height } = room.bounds;

  const doorIdxSet = new Set(room.doors.map((door) => door.y * w + door.x));

  // Collect passable, non-door perimeter tiles in a fixed order (top row, bottom
  // row, then left/right columns) so the wall-vs-door decision is deterministic.
  const gaps: number[] = [];
  const considerGap = (tx: number, ty: number): void => {
    const idx = ty * w + tx;
    if (doorIdxSet.has(idx)) return;
    const f = flags[idx]!;
    if ((f & TileFlags.PASSABLE) !== 0 && (f & TileFlags.DOOR) === 0) gaps.push(idx);
  };
  for (let tx = x; tx < x + width; tx += 1) {
    considerGap(tx, y);
    considerGap(tx, y + height - 1);
  }
  for (let ty = y + 1; ty < y + height - 1; ty += 1) {
    considerGap(x, ty);
    considerGap(x + width - 1, ty);
  }
  if (gaps.length === 0) return { walledTiles: [], addedDoors: [] };

  const spawnIdx = floorMap.playerSpawn.y * w + floorMap.playerSpawn.x;
  // Flood the tiles reachable from the player spawn over passable/door tiles,
  // treating `blocked` indices as walls (models the map after candidate walling).
  const floodFromSpawn = (blocked: ReadonlySet<number>): Uint8Array =>
    floodFill(spawnIdx, w, h, (idx) => {
      if (blocked.has(idx)) return false;
      const f = flags[idx]!;
      return (f & TileFlags.PASSABLE) !== 0 || (f & TileFlags.DOOR) !== 0;
    });

  const reachableBefore = floodFromSpawn(new Set());
  const walled = new Set<number>();
  for (const gap of gaps) {
    const candidate = new Set(walled);
    candidate.add(gap);
    const reachableAfter = floodFromSpawn(candidate);
    let strands = false;
    for (let idx = 0; idx < reachableBefore.length; idx += 1) {
      if (reachableBefore[idx] === 1 && reachableAfter[idx] === 0 && !candidate.has(idx)) {
        strands = true;
        break;
      }
    }
    // Non-load-bearing gaps become wall; load-bearing gaps stay open as doors.
    if (!strands) walled.add(gap);
  }

  const addedDoors: DoorLocation[] = [];
  for (const idx of gaps) {
    if (walled.has(idx)) {
      flags[idx] = TilePresets.WALL;
      terrain[idx] = TerrainType.STONE_WALL;
    } else {
      flags[idx] = TilePresets.DOOR_CLOSED;
      terrain[idx] = TerrainType.DOOR;
      const [dx, dy] = indexToCoords(idx, w);
      addedDoors.push({ x: dx, y: dy, connectsTo: -1 });
    }
  }
  if (addedDoors.length > 0) {
    // RoomData.doors is readonly at the type level; rebuild it as a fresh array
    // (mirrors how the generator rewrites door lists via Object.assign).
    Object.assign(room, { doors: [...room.doors, ...addedDoors] });
  }

  return { walledTiles: [...walled], addedDoors };
}

/**
 * Seal every special room on the floor. By default that is every SAFE and
 * BOSS_STAIR room; callers may add objective/boss rooms via `extraRoomIds` and
 * opt specific rooms out via `skipRoomIds`. Rooms are sealed in ascending id
 * order for determinism. Returns the per-room seal result keyed by room id.
 */
export function sealSpecialRooms(
  floorMap: FloorMap,
  options: SealSpecialRoomsOptions = {},
): Map<number, SealRoomResult> {
  const roles = options.roles ?? DEFAULT_SPECIAL_ROOM_ROLES;
  const skip = options.skipRoomIds ?? new Set<number>();

  const roomIds = new Set<number>();
  for (const role of roles) {
    for (const room of floorMap.roomGraph.getRoomsByRole(role)) roomIds.add(room.id);
  }
  if (options.extraRoomIds) {
    for (const id of options.extraRoomIds) roomIds.add(id);
  }

  const results = new Map<number, SealRoomResult>();
  for (const id of [...roomIds].sort((a, b) => a - b)) {
    if (skip.has(id)) continue;
    const room = floorMap.roomGraph.get(id);
    if (!room) continue;
    results.set(id, sealRoomPerimeter(floorMap, room));
  }
  return results;
}
