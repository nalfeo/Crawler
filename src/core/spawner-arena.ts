/**
 * Pure geometry + predicate helpers for the spawner-arena feature.
 *
 * Lives in `src/core/` so both the game-layer system (`spawnerArenaSystem`)
 * and any headless test can import them without touching game-specific state.
 * No side effects, no ECS mutation — everything here is a `(inputs) => outputs`
 * function on plain data.
 *
 * NOTE (ADR 0046): the pre-PR-#767 module also owned fence-ring tile
 * mutation (`FENCE_TILE_FLAGS`, `raiseFence`, `lowerFence`,
 * `collectFenceRingTiles`, `assertFenceBlocks`). Those helpers are gone —
 * dynamic barriers replaced the whole tile-mutation approach. Ring geometry
 * now lives in `src/core/barriers/geometry.ts` (`collectRingTiles`), which
 * is agnostic of underlying tile passability and therefore never produces
 * the "ring landed on walls, cage leaked" bug the fence path used to hit.
 */

import type { FloorMap } from './map/FloorMap.js';
import type { RoomData } from '../shared/map-types.js';

/**
 * Cap on how many child-XP intercepts a single spawner banks. Matches the
 * user's original wording ("up to 10") and spec `Requirements§7`.
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
  return dx * dx + dy * dy <= arenaRadiusFt * arenaRadiusFt;
}

/**
 * Combined trigger predicate (spec `Requirements§3`): player must be either
 * within the arena disc OR standing in the same room as the spawner when the
 * arena is sealed.
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
 * lies entirely inside `bounds` (tile-space rectangle).
 */
export function discFitsInRoom(params: {
  readonly cxFt: number;
  readonly cyFt: number;
  readonly radiusFt: number;
  readonly bounds: RoomData['bounds'];
  readonly tileSizeFt: number;
}): boolean {
  const { cxFt, cyFt, radiusFt, bounds, tileSizeFt } = params;
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
