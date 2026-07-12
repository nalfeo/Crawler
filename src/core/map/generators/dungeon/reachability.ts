/**
 * Connectivity & reachability repair for the dungeon generator.
 *
 * - `floodReachableTiles` — BFS/DFS flood over PASSABLE+DOOR tiles (optionally
 *   avoiding a blocked region).
 * - `cullIsolatedFloorTiles` — wall off passable tiles not reachable from spawn.
 * - `roomInteriorStatus` / `buildRoomBlockMask` — room-level reachability helpers.
 * - `ensureRoomsReachable` (EXPORTED) — guarantee every room is reachable before culling.
 * - `carveRoomConnector` — carve a minimal corridor to reconnect an isolated room.
 *
 * Extracted from DungeonGenerator.ts (behavior-preserving split). Depends on
 * `doors.getDoorSide` to open doors inward when seeding connector BFS.
 */

import type { RoomBounds, DoorLocation } from '../../../../shared/map-types';
import { TilePresets, TileFlags, TerrainType, RoomRole } from '../../../../shared/map-types';
import { TileMap } from '../../TileMap';
import { RoomGraph } from '../../RoomGraph';
import { getDoorSide } from './doors';

/**
 * Flood-fill from the player spawn, treating all PASSABLE tiles and DOOR tiles
 * as walkable. Any passable non-door tile that is NOT reached is converted to a
 * wall, eliminating isolated floor pockets created by room-shape post-processing.
 */
export function cullIsolatedFloorTiles(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  h: number,
  playerSpawn: { x: number; y: number },
): void {
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];

  const startIdx = playerSpawn.y * w + playerSpawn.x;
  visited[startIdx] = 1;
  stack.push(startIdx);

  while (stack.length > 0) {
    const idx = stack.pop()!;
    const cx = idx % w;
    const cy = (idx - cx) / w;

    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx]) continue;
      const flags = tileMap.flags[nIdx]!;
      // Treat doors (open or closed) as walkable for connectivity purposes
      const isDoor = (flags & TileFlags.DOOR) !== 0;
      const isPassable = (flags & TileFlags.PASSABLE) !== 0;
      if (!isPassable && !isDoor) continue;
      visited[nIdx] = 1;
      stack.push(nIdx);
    }
  }

  // Wall off any passable non-door tile that was not reached
  for (let idx = 0; idx < w * h; idx++) {
    if (visited[idx]) continue;
    const flags = tileMap.flags[idx]!;
    const isDoor = (flags & TileFlags.DOOR) !== 0;
    const isPassable = (flags & TileFlags.PASSABLE) !== 0;
    if (isPassable && !isDoor) {
      tileMap.flags[idx] = TilePresets.WALL;
      terrain[idx] = TerrainType.STONE_WALL;
    }
  }
}

/**
 * Flood-fill from a start tile over PASSABLE + DOOR tiles, returning a visited
 * bitmap. Mirrors the connectivity model used by cullIsolatedFloorTiles and the
 * AI pathfinder (closed doors are walkable for reachability — the door system
 * opens them on approach). When `blocked` is supplied, tiles flagged in it are
 * treated as impassable, letting callers measure reachability that avoids a
 * particular region (e.g. the locked boss-stair room).
 */
function floodReachableTiles(
  tileMap: TileMap,
  w: number,
  h: number,
  start: { x: number; y: number },
  blocked?: Uint8Array | null,
): Uint8Array {
  const visited = new Uint8Array(w * h);
  const startIdx = start.y * w + start.x;
  if (startIdx < 0 || startIdx >= w * h) return visited;
  if (blocked && blocked[startIdx]) return visited;
  visited[startIdx] = 1;
  const stack: number[] = [startIdx];
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const cx = idx % w;
    const cy = (idx - cx) / w;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx]) continue;
      if (blocked && blocked[nIdx]) continue;
      const flags = tileMap.flags[nIdx]!;
      if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) continue;
      visited[nIdx] = 1;
      stack.push(nIdx);
    }
  }
  return visited;
}

/** Does the room have ≥1 passable interior tile, and is any of them reachable? */
function roomInteriorStatus(
  tileMap: TileMap,
  w: number,
  room: { bounds: RoomBounds },
  reachable: Uint8Array,
): { hasInterior: boolean; connected: boolean } {
  const { x, y, width, height } = room.bounds;
  let hasInterior = false;
  for (let ty = y + 1; ty < y + height - 1; ty++) {
    for (let tx = x + 1; tx < x + width - 1; tx++) {
      const idx = ty * w + tx;
      if ((tileMap.flags[idx]! & TileFlags.PASSABLE) === 0) continue;
      hasInterior = true;
      if (reachable[idx] === 1) return { hasInterior: true, connected: true };
    }
  }
  return { hasInterior, connected: false };
}

/** Build a mask covering every tile inside a room's bounds plus its door tiles. */
function buildRoomBlockMask(
  room: { bounds: RoomBounds; doors: readonly DoorLocation[] },
  w: number,
  h: number,
): Uint8Array {
  const mask = new Uint8Array(w * h);
  const { x, y, width, height } = room.bounds;
  for (let ty = Math.max(0, y); ty < Math.min(h, y + height); ty++) {
    for (let tx = Math.max(0, x); tx < Math.min(w, x + width); tx++) {
      mask[ty * w + tx] = 1;
    }
  }
  for (const door of room.doors) {
    if (door.x >= 0 && door.y >= 0 && door.x < w && door.y < h) {
      mask[door.y * w + door.x] = 1;
    }
  }
  return mask;
}

/**
 * Guarantee that every room is reachable from the player spawn before isolated
 * floor tiles are culled. rot-js's Uniform generator occasionally emits a room
 * whose only corridor link fails to reach the spawn component; cullIsolatedFloorTiles
 * would then wall off that room's entire interior. On Floor 1 the affected room is
 * usually the farthest one — which preAssignRoles tags BOSS_STAIR — so its loss
 * strands the staircase (the floor exit) in solid rock and makes the floor
 * unwinnable by any weapon or AI.
 *
 * Two phases keep locked-door gating intact:
 * 1. Connect every non-spawn, non-boss room so it is reachable WITHOUT passing
 *    through the (locked) boss-stair room. Gate-quest rooms (shop, fetch item)
 *    therefore never deadlock behind the boss doors.
 * 2. Connect the boss-stair room itself, routed to its door so entry is still
 *    governed by the lock.
 *
 * Determinism & safety:
 * - Consumes NO RNG, so downstream procedural placement is unaffected.
 * - A strict no-op for already-reachable rooms (including rooms legitimately
 *   reachable only through the boss room) — a well-formed seed's tile flags and
 *   terrain are left byte-identical.
 *
 * Exported for unit testing. Not part of the public map API.
 */
export function ensureRoomsReachable(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  h: number,
  playerSpawn: { x: number; y: number },
): void {
  const bossRoom = roomGraph.getFirstRoomByRole(RoomRole.BOSS_STAIR);
  if (bossRoom) {
    ensureBossArenaInterior(tileMap, terrain, w, h, bossRoom);
  }
  const bossBlocked = bossRoom ? buildRoomBlockMask(bossRoom, w, h) : null;

  // Phase 1 — every non-spawn, non-boss room reachable without the boss room.
  let reachableNoBoss = floodReachableTiles(tileMap, w, h, playerSpawn, bossBlocked);
  for (const room of roomGraph.getAll()) {
    if (room.role === RoomRole.SPAWN) continue;
    if (bossRoom && room.id === bossRoom.id) continue;
    const { width, height } = room.bounds;
    if (width < 3 || height < 3) continue;

    const status = roomInteriorStatus(tileMap, w, room, reachableNoBoss);
    if (!status.hasInterior || status.connected) continue;

    // Reachable only through the boss room? Leave it untouched — floor1Scenario
    // already declines to place pre-boss quests in such rooms, and rewriting them
    // would perturb otherwise well-formed seeds. Only TRULY isolated rooms (sealed
    // off even with every door open) get a carved connector.
    const reachableOpen = floodReachableTiles(tileMap, w, h, playerSpawn);
    if (roomInteriorStatus(tileMap, w, room, reachableOpen).connected) continue;

    if (carveRoomConnector(tileMap, terrain, w, h, room, reachableNoBoss, bossBlocked)) {
      reachableNoBoss = floodReachableTiles(tileMap, w, h, playerSpawn, bossBlocked);
    }
  }

  // Phase 2 — the boss-stair room itself, routed via its door (lock still gates entry).
  if (bossRoom) {
    const { width, height } = bossRoom.bounds;
    if (width >= 3 && height >= 3) {
      const reachableOpen = floodReachableTiles(tileMap, w, h, playerSpawn);
      const status = roomInteriorStatus(tileMap, w, bossRoom, reachableOpen);
      if (status.hasInterior && !status.connected) {
        carveRoomConnector(tileMap, terrain, w, h, bossRoom, reachableOpen, null);
      }
    }
  }
}

/**
 * Guarantees enough deterministic interior floor for separated boss placement.
 * Valid rectangular and elliptical boss rooms already contain this centered
 * block, so the repair is byte-identical unless generation left the arena
 * partially or wholly walled.
 */
function ensureBossArenaInterior(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  h: number,
  room: { bounds: RoomBounds; doors: readonly DoorLocation[] },
): void {
  const { x, y, width, height } = room.bounds;
  const interiorWidth = Math.max(0, width - 2);
  const interiorHeight = Math.max(0, height - 2);
  if (interiorWidth === 0 || interiorHeight === 0) return;

  const arenaWidth = Math.min(5, interiorWidth);
  const arenaHeight = Math.min(5, interiorHeight);
  const arenaX = x + 1 + Math.floor((interiorWidth - arenaWidth) / 2);
  const arenaY = y + 1 + Math.floor((interiorHeight - arenaHeight) / 2);
  const centerX = arenaX + Math.floor(arenaWidth / 2);
  const centerY = arenaY + Math.floor(arenaHeight / 2);

  const carveInterior = (tx: number, ty: number): void => {
    if (tx <= x || ty <= y || tx >= x + width - 1 || ty >= y + height - 1) return;
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return;
    const idx = ty * w + tx;
    if ((tileMap.flags[idx]! & TileFlags.DOOR) !== 0) return;
    tileMap.flags[idx] = TilePresets.FLOOR;
    terrain[idx] = TerrainType.BOSS_STAIR_FLOOR;
  };

  for (let ty = arenaY; ty < arenaY + arenaHeight; ty += 1) {
    for (let tx = arenaX; tx < arenaX + arenaWidth; tx += 1) {
      carveInterior(tx, ty);
    }
  }

  for (const door of room.doors) {
    const side = getDoorSide(room.bounds, door);
    const inwardX = side === 'left' ? door.x + 1 : side === 'right' ? door.x - 1 : door.x;
    const inwardY = side === 'top' ? door.y + 1 : side === 'bottom' ? door.y - 1 : door.y;
    const stepX = inwardX <= centerX ? 1 : -1;
    for (let tx = inwardX; tx !== centerX + stepX; tx += stepX) {
      carveInterior(tx, inwardY);
    }
    const stepY = inwardY <= centerY ? 1 : -1;
    for (let ty = inwardY; ty !== centerY + stepY; ty += stepY) {
      carveInterior(centerX, ty);
    }
  }
}

/**
 * Carve a minimal corridor connecting an isolated room to the spawn-reachable
 * component. Performs a breadth-first search outward from the room's door tiles
 * (4-connected, through walls) to the nearest reachable tile, then converts the
 * intervening wall tiles to passable corridor floor. Also opens each door inward
 * by ensuring its interior-adjacent tile is passable. When `blocked` is supplied,
 * those tiles are never traversed or carved, so the connector avoids a forbidden
 * region (the locked boss room). Deterministic (fixed neighbour order, BFS by
 * insertion order). Returns true when a connector was carved.
 */
function carveRoomConnector(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  h: number,
  room: { id: number; bounds: RoomBounds; doors: readonly DoorLocation[] },
  reachable: Uint8Array,
  blocked: Uint8Array | null,
): boolean {
  const { x, y, width, height } = room.bounds;
  const isRoomPerimeterNonDoor = (idx: number): boolean => {
    if (room.doors.length === 0) return false;
    const tx = idx % w;
    const ty = (idx - tx) / w;
    const onPerimeter =
      tx >= x &&
      tx < x + width &&
      ty >= y &&
      ty < y + height &&
      (tx === x || tx === x + width - 1 || ty === y || ty === y + height - 1);
    if (!onPerimeter) return false;
    const flags = tileMap.flags[idx]!;
    return (flags & TileFlags.DOOR) === 0;
  };

  // Seed BFS from door tiles when present (preserves door-gated entry); fall back
  // to the interior perimeter for the rare door-less room.
  const seeds: number[] = [];
  if (room.doors.length > 0) {
    for (const door of room.doors) {
      seeds.push(door.y * w + door.x);
      // Open the door inward so the exterior connector reaches the interior.
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
      if (ix >= 0 && iy >= 0 && ix < w && iy < h) {
        const iIdx = iy * w + ix;
        const flags = tileMap.flags[iIdx]!;
        if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) {
          tileMap.flags[iIdx] = TilePresets.FLOOR;
          terrain[iIdx] = TerrainType.CORRIDOR;
        }
      }
    }
  } else {
    for (let tx = x; tx < x + width; tx++) {
      seeds.push(y * w + tx);
      seeds.push((y + height - 1) * w + tx);
    }
    for (let ty = y + 1; ty < y + height - 1; ty++) {
      seeds.push(ty * w + x);
      seeds.push(ty * w + (x + width - 1));
    }
  }

  const parent = new Int32Array(w * h).fill(-2); // -2 unvisited, -1 BFS source
  const queue: number[] = [];
  for (const s of seeds) {
    if (s < 0 || s >= w * h) continue;
    if (blocked && blocked[s]) continue;
    if (parent[s] === -2) {
      parent[s] = -1;
      queue.push(s);
    }
  }

  let target = -1;
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head]!;
    // A tile in the spawn component that we did not start from = bridge endpoint.
    if (reachable[idx] === 1 && parent[idx] !== -1) {
      target = idx;
      break;
    }
    const cx = idx % w;
    const cy = (idx - cx) / w;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (parent[nIdx] !== -2) continue;
      if (blocked && blocked[nIdx]) continue;
      if (isRoomPerimeterNonDoor(nIdx)) continue;
      parent[nIdx] = idx;
      queue.push(nIdx);
    }
  }

  if (target === -1) return false;

  // Carve the bridge: convert non-passable, non-door tiles along the path to
  // corridor floor. Door tiles and already-passable tiles are left untouched.
  let cursor = target;
  let carvedAny = false;
  while (cursor >= 0) {
    const flags = tileMap.flags[cursor]!;
    const isDoor = (flags & TileFlags.DOOR) !== 0;
    const isPassable = (flags & TileFlags.PASSABLE) !== 0;
    if (!isDoor && !isPassable) {
      tileMap.flags[cursor] = TilePresets.FLOOR;
      terrain[cursor] = TerrainType.CORRIDOR;
      carvedAny = true;
    }
    cursor = parent[cursor]!;
  }
  return carvedAny;
}
