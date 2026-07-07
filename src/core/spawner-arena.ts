/**
 * Pure geometry + predicate helpers for the spawner-arena feature.
 *
 * Lives in `src/core/` so both the game-layer system (`spawnerArenaSystem`)
 * and any headless test can import them without touching game-specific state.
 * No side effects, no ECS mutation, no imports from `src/game/` — everything
 * here is a `(inputs) => outputs` function on plain data.
 *
 * The arena state machine, VFX-event pushing, and door/tile mutation live in
 * `src/game/spawners/spawnerArenaSystem.ts` (where they can resolve archetype
 * data). This module intentionally has zero policy — only geometry and
 * membership tests — so it can be reused by the labs (`spawner-lab`) and unit
 * tests without spinning up a full world.
 */

import type { FloorMap } from './map/FloorMap.js';
import type { RoomData } from '../shared/map-types.js';
import { TileFlags } from '../shared/map-types.js';

/**
 * Cap on how many child-XP intercepts a single spawner banks. Matches the
 * user's original wording ("up to 10") and spec `Requirements§7`. Making the
 * cap a constant keeps unit tests and the HUD in lockstep without a magic
 * number floating around.
 */
export const SPAWNER_MAX_BANKED_CHILDREN = 10;

/**
 * Result of the sealable-vs-fence decision. Mirrors the two concrete arenaKind
 * SoA values (`0` = sealed-room, `1` = open-fence). There is intentionally no
 * `unresolved` member here: the "no floorMap yet / not yet decided" state is
 * represented in the SoA by the numeric sentinel `255`
 * (`SPAWNER_ARENA_KIND_UNRESOLVED`), never by this string union.
 */
export type ArenaKind = 'sealed-room' | 'open-fence';

/** True if `dist(player, spawner) ≤ arenaRadiusFt`. */
export function isPlayerInArenaRadius(
  playerX: number,
  playerY: number,
  spawnerX: number,
  spawnerY: number,
  arenaRadiusFt: number,
): boolean {
  const dx = playerX - spawnerX;
  const dy = playerY - spawnerY;
  // Squared-distance comparison keeps this a pure integer/float multiply — no
  // sqrt, no allocation, safe from denormal-float subtractions.
  return dx * dx + dy * dy <= arenaRadiusFt * arenaRadiusFt;
}

/**
 * Combined trigger predicate (spec `Requirements§3`): player must be either
 * within the arena disc OR standing in the same room as the spawner when the
 * arena is sealed. The `sameRoom` half handles a huge room where the player
 * legitimately walked past the disc without stepping in it.
 */
export function isArenaTriggered(params: {
  readonly playerX: number;
  readonly playerY: number;
  readonly spawnerX: number;
  readonly spawnerY: number;
  readonly arenaRadiusFt: number;
  readonly sameSealedRoom: boolean;
}): boolean {
  if (params.sameSealedRoom) return true;
  return isPlayerInArenaRadius(
    params.playerX,
    params.playerY,
    params.spawnerX,
    params.spawnerY,
    params.arenaRadiusFt,
  );
}

/**
 * True iff the arena disc (centred at `(x,y)` in feet, radius `r` in feet)
 * lies entirely inside `bounds` (tile-space rectangle). Required for the
 * sealed-room decision (`Requirements§2`) so we never lock a room whose
 * walls the arena disc would poke through.
 *
 * Bounds are treated as inclusive of the axis-aligned rectangle; a 1-tile
 * inset is applied because room walls occupy the outermost row/column.
 */
export function discFitsInRoom(params: {
  readonly cxFt: number;
  readonly cyFt: number;
  readonly radiusFt: number;
  readonly bounds: RoomData['bounds'];
  readonly tileSizeFt: number;
}): boolean {
  const { cxFt, cyFt, radiusFt, bounds, tileSizeFt } = params;
  // Interior = the 1-tile inset of the bounds (walls sit on the perimeter).
  const minXFt = (bounds.x + 1) * tileSizeFt;
  const minYFt = (bounds.y + 1) * tileSizeFt;
  const maxXFt = (bounds.x + bounds.width - 1) * tileSizeFt;
  const maxYFt = (bounds.y + bounds.height - 1) * tileSizeFt;
  return (
    cxFt - radiusFt >= minXFt &&
    cxFt + radiusFt <= maxXFt &&
    cyFt - radiusFt >= minYFt &&
    cyFt + radiusFt <= maxYFt
  );
}

/**
 * Resolve the arena kind for a spawner given the floor map.
 *
 * A room is sealed iff:
 *   - the spawner tile maps to a room (not a corridor / open cave), AND
 *   - the room has at least one door (something to actually lock), AND
 *   - the arena disc fits fully inside the room's bounding rectangle.
 *
 * Otherwise the arena materialises as an open-fence ring around the spawner.
 * When no floor map is present (e.g. labs, unit tests), the caller should
 * skip the sealed path and fall through to open-fence, so this helper
 * requires an explicit map.
 */
export function decideArenaKind(params: {
  readonly floorMap: FloorMap;
  readonly spawnerXFt: number;
  readonly spawnerYFt: number;
  readonly arenaRadiusFt: number;
}): ArenaKind {
  const { floorMap, spawnerXFt, spawnerYFt, arenaRadiusFt } = params;
  const tile = floorMap.worldToTile(spawnerXFt, spawnerYFt);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  if (roomId < 0) return 'open-fence';
  const room = floorMap.roomGraph.get(roomId);
  if (!room || room.doors.length === 0) return 'open-fence';
  const fits = discFitsInRoom({
    cxFt: spawnerXFt,
    cyFt: spawnerYFt,
    radiusFt: arenaRadiusFt,
    bounds: room.bounds,
    tileSizeFt: floorMap.config.tileSizeFt,
  });
  return fits ? 'sealed-room' : 'open-fence';
}

/**
 * Enumerate the tile indices on the fence ring surrounding a spawner.
 *
 * A tile counts as "on the ring" when its centre is within one half-tile of
 * the arena radius (distance ∈ (r - halfTile, r + halfTile]). The result is
 * always in deterministic row-major order so state written to
 * `world.spawnerArenaFence[eid]` replays byte-identically across runs with
 * the same seed.
 *
 * Only currently-passable tiles are returned — walls and already-blocked
 * tiles have nothing to convert, and door tiles are excluded (they are the
 * sealed-room path's responsibility).
 */
export function collectFenceRingTiles(params: {
  readonly floorMap: FloorMap;
  readonly cxFt: number;
  readonly cyFt: number;
  readonly radiusFt: number;
}): number[] {
  const { floorMap, cxFt, cyFt, radiusFt } = params;
  const { tileMap } = floorMap;
  const tileSizeFt = floorMap.config.tileSizeFt;
  const halfTile = tileSizeFt / 2;
  const outer = radiusFt + halfTile;
  const inner = Math.max(0, radiusFt - halfTile);
  const outerSq = outer * outer;
  const innerSq = inner * inner;
  const cTile = floorMap.worldToTile(cxFt, cyFt);
  const tilesReach = Math.ceil(outer / tileSizeFt) + 1;
  const tiles: number[] = [];
  for (let ty = cTile.y - tilesReach; ty <= cTile.y + tilesReach; ty += 1) {
    for (let tx = cTile.x - tilesReach; tx <= cTile.x + tilesReach; tx += 1) {
      if (!tileMap.inBounds(tx, ty)) continue;
      // Door tiles belong to the sealed-room path; never overwrite them.
      if (tileMap.isDoor(tx, ty)) continue;
      // Only convert currently-passable floor: converting a wall does nothing
      // and inflates the snapshot needlessly. LOS-blockers are also OK to
      // leave alone (they already prevent traversal).
      if (!tileMap.isPassable(tx, ty)) continue;
      const centreX = tx * tileSizeFt + halfTile;
      const centreY = ty * tileSizeFt + halfTile;
      const dx = centreX - cxFt;
      const dy = centreY - cyFt;
      const distSq = dx * dx + dy * dy;
      if (distSq > outerSq) continue;
      if (distSq <= innerSq) continue;
      tiles.push(tileMap.index(tx, ty));
    }
  }
  return tiles;
}

/**
 * Fence tile flag preset. Clears PASSABLE (so movement + projectiles are
 * blocked by the tileMap) but keeps TRANSPARENT (so FOV rays still pass —
 * the fence should feel like a shimmering barrier, not a black hole).
 * Callers snapshot the original byte before overwriting so restore is exact.
 */
export const FENCE_TILE_FLAGS = TileFlags.TRANSPARENT as number;

/** Sanity: `FENCE_TILE_FLAGS` MUST clear at least the PASSABLE bit. */
export function assertFenceBlocks(): void {
  if ((FENCE_TILE_FLAGS & TileFlags.PASSABLE) !== 0) {
    throw new Error('FENCE_TILE_FLAGS must have PASSABLE cleared.');
  }
}
