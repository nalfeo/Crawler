/**
 * Barrier registry — create/drop lifecycle + O(1) tile membership.
 *
 * All mutation goes through the helpers here so that:
 *   1. `blockedTiles` stays a perfect union of every active barrier's tiles.
 *   2. `version` bumps exactly once per mutation (renderers cache-invalidate).
 *   3. Handle ids are never recycled inside a run (safe stale-handle compares).
 *
 * The `world` argument is typed via a structural interface (`BarrierWorld`)
 * rather than importing `GameWorld` so unit tests can construct a minimal
 * fake without dragging the ECS in. `barriers.ts` re-exports the real
 * `GameWorld`-typed wrappers.
 */
import type { BarrierHandle, BarrierKind, BarrierRegistry } from './types.js';
import { collectRingTiles, collectRoomDoorwayTiles, collectRoomInteriorTiles } from './geometry.js';
import type { FloorMap } from '../map/FloorMap.js';

/**
 * Minimal world surface the barrier registry needs. Kept structural so the
 * primitive stays independent of the full `GameWorld` type — helpful for
 * unit tests and for callers that hold only a floor map + registry.
 */
export interface BarrierWorld {
  readonly floorMap: FloorMap | null;
  readonly barriers: BarrierRegistry;
}

/** Create a fresh, empty registry. Called once by `createGameWorld`. */
export function createBarrierRegistry(): BarrierRegistry {
  return {
    barriers: new Map(),
    blockedTiles: new Set(),
    version: 0,
    nextId: 1,
  };
}

/**
 * Insert a handle into the registry, updating `blockedTiles` and bumping
 * `version`. Duplicate tile indices across barriers are handled naturally by
 * the `Set` — the tile is blocked as long as at least one live barrier
 * references it.
 */
function registerHandle(registry: BarrierRegistry, handle: BarrierHandle): void {
  registry.barriers.set(handle.id, handle);
  for (const tileIdx of handle.tiles) {
    registry.blockedTiles.add(tileIdx);
  }
  registry.version += 1;
}

/**
 * Remove a handle. If two barriers overlap on a tile, the tile stays in
 * `blockedTiles` while the other barrier still references it. Callers must
 * pass a handle they created themselves — dropping an unknown id is a no-op
 * (idempotent for late double-drops during arena resolution).
 */
export function dropBarrier(world: BarrierWorld, handleOrId: BarrierHandle | number): void {
  const id = typeof handleOrId === 'number' ? handleOrId : handleOrId.id;
  const registry = world.barriers;
  const handle = registry.barriers.get(id);
  if (!handle) return;
  registry.barriers.delete(id);
  // Rebuild blockedTiles for the tiles this handle owned: keep those still
  // referenced by another barrier, drop the rest. O(k · avgOverlap) where k
  // is the size of this handle's tile list — well under the 1 ms per-frame
  // physics budget even for a room-scale barrier.
  for (const tileIdx of handle.tiles) {
    let stillBlocked = false;
    for (const other of registry.barriers.values()) {
      if (other.tiles.includes(tileIdx)) {
        stillBlocked = true;
        break;
      }
    }
    if (!stillBlocked) registry.blockedTiles.delete(tileIdx);
  }
  registry.version += 1;
}

/**
 * True iff `tileIdx` is currently occupied by any live barrier. Physics
 * chokepoints (`FloorMap.isPassableAt`, pathfinder, projectile cleanup) call
 * this per tile, so it must be O(1). A `Set.has` is exactly that.
 */
export function isBarrierTile(world: BarrierWorld, tileIdx: number): boolean {
  return world.barriers.blockedTiles.has(tileIdx);
}

/**
 * True iff a world-space (feet) point sits on a barrier tile. Convenience
 * wrapper for movement/collision code that already works in feet.
 */
export function isBarrierAt(world: BarrierWorld, xFt: number, yFt: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) return false;
  const tile = floorMap.worldToTile(xFt, yFt);
  if (!floorMap.tileMap.inBounds(tile.x, tile.y)) return false;
  const idx = floorMap.tileMap.index(tile.x, tile.y);
  return isBarrierTile(world, idx);
}

/**
 * Raise a circular ring barrier around `(cxFt, cyFt)` at radius `radiusFt`.
 * All ring tiles are added regardless of underlying passability — a ring
 * tile that coincides with a wall stays in the barrier set. See geometry.ts
 * for the fence-vs-wall rationale.
 */
export function createRingBarrier(
  world: BarrierWorld,
  cxFt: number,
  cyFt: number,
  radiusFt: number,
  kind: BarrierKind,
): BarrierHandle {
  const floorMap = world.floorMap;
  const tiles = floorMap ? collectRingTiles({ floorMap, cxFt, cyFt, radiusFt }) : [];
  const handle: BarrierHandle = {
    id: world.barriers.nextId,
    kind,
    tiles,
  };
  world.barriers.nextId += 1;
  registerHandle(world.barriers, handle);
  return handle;
}

/**
 * Raise a barrier covering the doors of a room ({ doorwaysOnly: true }, the
 * default) or every interior tile of a room ({ doorwaysOnly: false }).
 *
 * The doorway-only mode is the spawner arena's sealed-room belt-and-
 * suspenders: doors still lock via `setDoorLockConfig`, and the barrier
 * physically plugs every doorway so an unlock-predicate bug or a rogue
 * "open all doors" script cannot let the player out.
 */
export function createRoomBarrier(
  world: BarrierWorld,
  roomId: number,
  kind: BarrierKind,
  options: { doorwaysOnly?: boolean } = {},
): BarrierHandle {
  const floorMap = world.floorMap;
  const doorwaysOnly = options.doorwaysOnly ?? true;
  const tiles =
    floorMap == null
      ? []
      : doorwaysOnly
        ? collectRoomDoorwayTiles({ floorMap, roomId })
        : collectRoomInteriorTiles({ floorMap, roomId });
  const handle: BarrierHandle = {
    id: world.barriers.nextId,
    kind,
    tiles,
  };
  world.barriers.nextId += 1;
  registerHandle(world.barriers, handle);
  return handle;
}

/**
 * Raise a barrier covering an arbitrary tile list — the low-level escape
 * hatch. Callers pass tile INDICES into `floorMap.tileMap.flags`; use
 * `TileMap.index(x, y)` to convert. Duplicate indices are deduped.
 */
export function createPolyBarrier(
  world: BarrierWorld,
  tiles: readonly number[],
  kind: BarrierKind,
): BarrierHandle {
  // Dedupe defensively — callers may pass geometry helpers that overlap.
  const uniqueTiles = Array.from(new Set(tiles));
  const handle: BarrierHandle = {
    id: world.barriers.nextId,
    kind,
    tiles: uniqueTiles,
  };
  world.barriers.nextId += 1;
  registerHandle(world.barriers, handle);
  return handle;
}
