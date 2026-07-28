/**
 * carveSetPieceRoom — make a set-piece prefab authoritative for a room's geometry.
 *
 * Under the prefab-room model a `SetPieceDef` owns its own shell: a real,
 * impassable wall ring and at least one door slot. Map generation carves/sizes
 * the target room to fit the prefab footprint and connects corridors to the
 * prefab's declared door slots. This module performs that carve as **tile writes
 * only** — it never allocates ECS entities. Allocating entity ids for dressing
 * would shift ambient-mob/drop ids and perturb the global RNG, breaking
 * headless↔rendered determinism (see `src/core/spawners/world-objects.ts`). The
 * carve is pure (no rendering / game imports) and fully deterministic: every
 * choice is derived from geometry with fixed scan orders, never `Math.random`.
 *
 * Algorithm (per room):
 *   1. Fit check — the footprint (plus a 1-tile margin) must fit inside the map.
 *   2. Anchor the new bounds centred on the old room centre, clamped in-bounds.
 *   3. Neighbour-overlap check — reject if the footprint overlaps another room.
 *   4. Resolve the prefab's declared door slots to concrete ring tiles.
 *   5. Rewrite the room's bounds + doors, paint the interior to floor, punch the
 *      declared doors, then reuse the proven {@link sealRoomPerimeter} to wall
 *      every passable ring breach that is not load-bearing (load-bearing breaches
 *      become doors so no spawn-reachable region is ever stranded).
 *   6. Connectivity backstop — if the interior ends up unreachable from spawn
 *      (e.g. the footprint grew into rock away from every corridor), carve a
 *      deterministic connector from the primary door out to the nearest
 *      spawn-reachable floor tile.
 *
 * On failure (footprint too large, or overlaps another room) it returns
 * `{ fitted: false }` and mutates nothing, so the caller can fall back to the
 * legacy render-only stamp and keep the floor winnable.
 */

import {
  TerrainType,
  TileFlags,
  TilePresets,
  type DoorLocation,
  type RoomBounds,
  type RoomData,
} from '../../shared/map-types.js';
import {
  resolveSetPieceDoorSlots,
  type SetPieceDef,
  type SetPieceDoorEdge,
  type SetPieceResolvedDoorSlot,
} from '../../shared/set-piece-types.js';
import type { FloorMap } from './FloorMap.js';
import { applySolidProps } from './applySolidProps.js';
import { ORTHO_NEIGHBORS } from './grid-utils.js';
import { restoreRoomInterior, sealRoomPerimeter } from './special-rooms.js';

/** Outcome of a prefab carve. `fitted: false` means the caller should fall back. */
export interface CarveSetPieceRoomResult {
  /** Whether the prefab was carved. `false` ⇒ nothing was mutated. */
  readonly fitted: boolean;
  /** Human-readable reason when `fitted` is `false` (for logging/telemetry). */
  readonly reason?: string;
  /** The room's new bounds (footprint-sized) when fitted. */
  readonly bounds?: RoomBounds;
  /** Resolved door tiles (world coords) written to the ring when fitted. */
  readonly doors?: readonly DoorLocation[];
  /** World tile the prefab's local (0,0) maps to — equals `bounds.{x,y}`. */
  readonly originTileX?: number;
  readonly originTileY?: number;
}

export interface CarveSetPieceRoomOptions {
  /** Interior floor terrain tint (default {@link TerrainType.STONE_FLOOR}). */
  readonly floorTerrain?: TerrainType;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Axis-aligned rectangle overlap (bounds include the 1-tile wall ring). */
function rectsOverlap(a: RoomBounds, b: RoomBounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Resolve the prefab's declared door slots to concrete ring tiles in world
 * coordinates. `fixed` slots pin to their authored tile; `dynamic` slots relocate
 * to the eligible-edge ring tile whose outward neighbour is the nearest
 * spawn-reachable floor tile (deterministic scan order, no RNG). If the prefab
 * declares no ring door at all, a single bottom-centre entrance is synthesised so
 * the room is never fully sealed.
 */
function resolveDoorTiles(
  def: SetPieceDef,
  bounds: RoomBounds,
  floorMap: FloorMap,
  reachable: Uint8Array,
): DoorLocation[] {
  const slots = resolveSetPieceDoorSlots(def);
  const doors: DoorLocation[] = [];
  const seen = new Set<number>();
  const w = floorMap.width;
  const push = (tileX: number, tileY: number): void => {
    const idx = tileY * w + tileX;
    if (seen.has(idx)) return;
    seen.add(idx);
    doors.push({ x: tileX, y: tileY, connectsTo: -1 });
  };

  for (const slot of slots) {
    if (slot.mode === 'dynamic') {
      const chosen = chooseDynamicDoorTile(slot, bounds, floorMap, reachable);
      push(chosen.x, chosen.y);
    } else {
      push(bounds.x + slot.x, bounds.y + slot.y);
    }
  }

  if (doors.length === 0) {
    push(bounds.x + Math.floor(bounds.width / 2), bounds.y + bounds.height - 1);
  }
  return doors;
}

/** Ring tiles on a given edge, in a fixed scan order (left→right / top→bottom). */
function edgeRingTiles(
  edge: SetPieceDoorEdge,
  bounds: RoomBounds,
): Array<{ x: number; y: number; outX: number; outY: number }> {
  const { x, y, width, height } = bounds;
  const tiles: Array<{ x: number; y: number; outX: number; outY: number }> = [];
  if (edge === 'top') {
    for (let tx = x + 1; tx < x + width - 1; tx += 1)
      tiles.push({ x: tx, y, outX: tx, outY: y - 1 });
  } else if (edge === 'bottom') {
    const ty = y + height - 1;
    for (let tx = x + 1; tx < x + width - 1; tx += 1)
      tiles.push({ x: tx, y: ty, outX: tx, outY: ty + 1 });
  } else if (edge === 'left') {
    for (let ty = y + 1; ty < y + height - 1; ty += 1)
      tiles.push({ x, y: ty, outX: x - 1, outY: ty });
  } else {
    const tx = x + width - 1;
    for (let ty = y + 1; ty < y + height - 1; ty += 1)
      tiles.push({ x: tx, y: ty, outX: tx + 1, outY: ty });
  }
  return tiles;
}

/**
 * Choose the ring tile for a dynamic door: among the slot's eligible edges (in
 * fixed edge order top→bottom→left→right, then left→right / top→bottom within an
 * edge), prefer the first tile whose outward neighbour is a spawn-reachable
 * passable floor tile. Falls back to the authored tile when no eligible edge tile
 * faces reachable floor (the connector backstop then guarantees reachability).
 *
 * PRECONDITION: `reachable` must be a settled spawn-reachability mask computed
 * BEFORE this carve mutates the tilemap (see `resolveDoorTiles`, which snapshots
 * it via `floodFromSpawn` prior to restoring the interior / punching doors).
 * Resolving a dynamic door against a half-mutated map would let the carve's own
 * in-progress wall/door writes bias the "nearest reachable floor" scan, breaking
 * the deterministic, order-independent choice this function guarantees.
 */
function chooseDynamicDoorTile(
  slot: SetPieceResolvedDoorSlot,
  bounds: RoomBounds,
  floorMap: FloorMap,
  reachable: Uint8Array,
): { x: number; y: number } {
  const edges = slot.edges ?? (['top', 'bottom', 'left', 'right'] as const);
  const w = floorMap.width;
  for (const edge of edges) {
    for (const tile of edgeRingTiles(edge, bounds)) {
      if (!floorMap.tileMap.inBounds(tile.outX, tile.outY)) continue;
      const outIdx = tile.outY * w + tile.outX;
      if (reachable[outIdx] === 1 && floorMap.tileMap.isPassable(tile.outX, tile.outY)) {
        return { x: tile.x, y: tile.y };
      }
    }
  }
  // Deterministic fallback: stay on the FIRST declared eligible edge tile, never
  // the authored prop origin (which may be on a different edge than `slot.edges`).
  for (const edge of edges) {
    const fallbackTile = edgeRingTiles(edge, bounds)[0];
    if (fallbackTile) {
      return { x: fallbackTile.x, y: fallbackTile.y };
    }
  }
  return { x: bounds.x + slot.x, y: bounds.y + slot.y };
}

function addRoomBoundsToAvoidSet(
  avoid: Set<number>,
  width: number,
  bounds: RoomBounds,
  exceptIdx?: number,
): void {
  for (let yy = bounds.y; yy < bounds.y + bounds.height; yy += 1) {
    for (let xx = bounds.x; xx < bounds.x + bounds.width; xx += 1) {
      const idx = yy * width + xx;
      if (idx !== exceptIdx) avoid.add(idx);
    }
  }
}

/** Flood the tiles reachable from the player spawn over passable/door tiles. */
function floodFromSpawn(floorMap: FloorMap): Uint8Array {
  const w = floorMap.width;
  const h = floorMap.height;
  const flags = floorMap.tileMap.flags;
  const visited = new Uint8Array(w * h);
  if (!floorMap.tileMap.inBounds(floorMap.playerSpawn.x, floorMap.playerSpawn.y)) {
    return visited;
  }
  const spawnIdx = floorMap.playerSpawn.y * w + floorMap.playerSpawn.x;
  const isOpen = (idx: number): boolean => {
    const f = flags[idx]!;
    return (f & TileFlags.PASSABLE) !== 0 || (f & TileFlags.DOOR) !== 0;
  };
  if (!isOpen(spawnIdx)) return visited;
  const queue: number[] = [spawnIdx];
  visited[spawnIdx] = 1;
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head]!;
    head += 1;
    const x = idx % w;
    const y = (idx - x) / w;
    for (const [dx, dy] of ORTHO_NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx] === 1 || !isOpen(nIdx)) continue;
      visited[nIdx] = 1;
      queue.push(nIdx);
    }
  }
  return visited;
}

/**
 * Carve a deterministic connector (BFS shortest path, fixed neighbour order) from
 * `(startX, startY)` through any tiles to the nearest tile flagged in `reachable`,
 * turning the path into corridor floor. Door tiles on the path are left intact.
 * Tiles whose index is present in `avoid` are never traversed, so a caller can
 * forbid the tunnel from routing through a gated region's interior (which would
 * otherwise open an unintended bypass around a locked door). Returns `false` only
 * if no reachable tile exists (a disconnected floor).
 */
export function carveConnectorToReachable(
  floorMap: FloorMap,
  startX: number,
  startY: number,
  reachable: Uint8Array,
  avoid?: ReadonlySet<number>,
): boolean {
  const w = floorMap.width;
  const h = floorMap.height;
  const startIdx = startY * w + startX;
  const prev = new Int32Array(w * h).fill(-1);
  const visited = new Uint8Array(w * h);
  const queue: number[] = [startIdx];
  visited[startIdx] = 1;
  let head = 0;
  let target = -1;
  while (head < queue.length) {
    const idx = queue[head]!;
    head += 1;
    if (reachable[idx] === 1) {
      target = idx;
      break;
    }
    const x = idx % w;
    const y = (idx - x) / w;
    for (const [dx, dy] of ORTHO_NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx] === 1) continue;
      // Never route through a forbidden tile (e.g. a locked room's interior) —
      // except the reachable target itself, which we stop on above.
      if (avoid !== undefined && avoid.has(nIdx) && reachable[nIdx] !== 1) continue;
      visited[nIdx] = 1;
      prev[nIdx] = idx;
      queue.push(nIdx);
    }
  }
  if (target < 0) return false;
  // Carve the path from the reachable target back toward the start, excluding the
  // target itself (already floor) and never overwriting door tiles.
  let cur = prev[target]!;
  while (cur !== -1 && cur !== startIdx) {
    const x = cur % w;
    const y = (cur - x) / w;
    if ((floorMap.tileMap.flags[cur]! & TileFlags.DOOR) === 0) {
      floorMap.tileMap.setFlags(x, y, TilePresets.FLOOR);
      floorMap.terrain[cur] = TerrainType.CORRIDOR;
    }
    cur = prev[cur]!;
  }
  return true;
}

/**
 * Carve a set-piece prefab to be authoritative for the target room's geometry.
 * See the module header for the algorithm. Mutates `floorMap` tiles + the room's
 * bounds/doors on success; mutates nothing on `fitted: false`.
 */
export function carveSetPieceRoom(
  floorMap: FloorMap,
  room: RoomData,
  def: SetPieceDef,
  options: CarveSetPieceRoomOptions = {},
): CarveSetPieceRoomResult {
  const w = floorMap.width;
  const h = floorMap.height;
  const fpW = def.width;
  const fpH = def.height;
  const floorTerrain = options.floorTerrain ?? TerrainType.STONE_FLOOR;

  // 1. Fit check — footprint plus a 1-tile margin must fit inside the map.
  if (fpW + 2 > w || fpH + 2 > h) {
    return { fitted: false, reason: 'footprint-larger-than-map' };
  }

  // 2. Anchor centred on the old room centre, clamped so the ring never touches
  //    the map edge (leaving room for a connector on any side).
  const oldB = room.bounds;
  const centerX = oldB.x + Math.floor(oldB.width / 2);
  const centerY = oldB.y + Math.floor(oldB.height / 2);
  const originX = clamp(centerX - Math.floor(fpW / 2), 1, w - 1 - fpW);
  const originY = clamp(centerY - Math.floor(fpH / 2), 1, h - 1 - fpH);
  const newBounds: RoomBounds = { x: originX, y: originY, width: fpW, height: fpH };

  // 3. Neighbour-overlap check — never corrupt another room's footprint.
  for (const other of floorMap.roomGraph.getAll()) {
    if (other.id === room.id) continue;
    if (rectsOverlap(newBounds, other.bounds)) {
      return { fitted: false, reason: `overlaps-room-${other.id}` };
    }
  }

  // 4. Resolve door slots against the pre-carve reachability so dynamic doors
  //    snap toward existing corridors.
  const reachableBefore = floodFromSpawn(floorMap);
  const doors = resolveDoorTiles(def, newBounds, floorMap, reachableBefore);

  // 5. Rewrite geometry, paint interior, punch doors, then seal the ring.
  // Clear any stale `interiorCells` mask: it described the pre-carve (possibly
  // irregular) footprint, and `getRoomAt` / `getRandomInteriorTile` prefer it over
  // `bounds`. The carved room is a rectangular prefab, so drop the mask and let
  // the bounds-inset interior take over.
  floorMap.roomGraph.updateRoom(room.id, {
    bounds: newBounds,
    doors,
    interiorCells: undefined,
  });
  const updated = floorMap.roomGraph.get(room.id)!;
  restoreRoomInterior(floorMap.tileMap.flags, floorMap.terrain, w, updated, floorTerrain);
  for (const door of doors) {
    floorMap.tileMap.setFlags(door.x, door.y, TilePresets.DOOR_CLOSED);
    floorMap.terrain[door.y * w + door.x] = TerrainType.DOOR;
  }
  // sealRoomPerimeter walls every passable non-door ring breach unless walling it
  // would strand a spawn-reachable region (those become closed doors). It skips
  // the declared doors (already in room.doors) and appends any load-bearing doors.
  sealRoomPerimeter(floorMap, updated);

  // 6. Connectivity backstop — guarantee the interior is spawn-reachable. Test an
  //    interior tile; if unreachable, carve a connector from the primary door. The
  //    primary door stays DOOR_CLOSED (as sealed above): a closed door is already
  //    traversable by the flood, and carveConnectorToReachable carves floor by
  //    position regardless of flags, so re-opening it here would only leave the
  //    door inconsistently OPEN vs the other sealed doors.
  const reachableAfter = floodFromSpawn(floorMap);
  const interiorX = originX + Math.floor(fpW / 2);
  const interiorY = originY + Math.floor(fpH / 2);
  if (reachableAfter[interiorY * w + interiorX] !== 1) {
    const primary = doors[0]!;
    const avoid = new Set<number>();
    for (const other of floorMap.roomGraph.getAll()) {
      if (other.id === updated.id) continue;
      addRoomBoundsToAvoidSet(avoid, w, other.bounds);
    }
    carveConnectorToReachable(floorMap, primary.x, primary.y, reachableBefore, avoid);
  }

  // 7. Physical collision for opt-in bulk furniture. Runs last so it sees the
  //    final door set, and is individually reverted for any prop that would
  //    disconnect the interior — see `applySolidProps`.
  applySolidProps(floorMap, def, originX, originY, newBounds, updated.doors);

  return {
    fitted: true,
    bounds: newBounds,
    doors: updated.doors,
    originTileX: originX,
    originTileY: originY,
  };
}
