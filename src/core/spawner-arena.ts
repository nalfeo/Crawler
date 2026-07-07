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
 * Wall thickness (ft) of an open-fence arena's procedural ring wall. The user
 * spec is a 1 ft-thick circular wall; kept as a named constant so the trigger
 * math, the barrier factory, and the renderer all agree on one value.
 */
export const ARENA_WALL_THICKNESS_FT = 1;

/**
 * Minimum OUTER radius (ft) of an open-fence ring-wall arena. An arena must be
 * big enough that its "fully inside" trigger radius (`outer − thickness −
 * playerBodyRadius`) still exceeds the AI's melee standoff to the spawner
 * (`CONTACT_SAFE_ORBIT_FT` = 4.5 ft), or the AI parks at its standoff OUTSIDE
 * the trigger and the arena never arms. With thickness 1 + player body 1.5,
 * `outer = 8` ⇒ trigger radius 5.5 ft = 4.5 standoff + 1 ft margin. Archetypes
 * that request a smaller radius (slime 6, rats-nest 7) are floored to this so
 * the cage reliably forms; larger requests (cave 10) pass through unchanged.
 */
export const MIN_ARENA_WALL_OUTER_FT = 8;

/**
 * Resolve the outer/inner radii of an open-fence arena's ring wall from a
 * requested arena radius. Applies {@link MIN_ARENA_WALL_OUTER_FT} and carves
 * the {@link ARENA_WALL_THICKNESS_FT}-thick band. `innerRadiusFt` is the
 * boundary of the passable interior disc; `outerRadiusFt` is the outer wall
 * face. Pure — same inputs, same radii.
 */
export function arenaRingWallRadii(arenaRadiusFt: number): {
  readonly outerRadiusFt: number;
  readonly innerRadiusFt: number;
} {
  const outerRadiusFt = Math.max(arenaRadiusFt, MIN_ARENA_WALL_OUTER_FT);
  const innerRadiusFt = Math.max(0, outerRadiusFt - ARENA_WALL_THICKNESS_FT);
  return { outerRadiusFt, innerRadiusFt };
}

/**
 * True iff the player's whole BODY sits inside the interior disc of a ring wall
 * — i.e. the player has committed FULLY inside the circle and no part of the
 * body pokes into the wall band. This is the open-fence arm gate (user spec:
 * "don't trigger until the user is FULLY inside the circle"), which guarantees
 * that when the wall materialises the player is never spawned inside it.
 *
 * Squared-distance comparison (no `sqrt`). Returns `false` when the interior is
 * too small to contain the body (`innerRadiusFt ≤ playerBodyRadiusFt`), so a
 * degenerate ring simply never arms rather than arming with the player stuck.
 */
export function isPlayerFullyInsideRing(params: {
  readonly playerX: number;
  readonly playerY: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly innerRadiusFt: number;
  readonly playerBodyRadiusFt: number;
}): boolean {
  const limit = params.innerRadiusFt - params.playerBodyRadiusFt;
  if (limit <= 0) return false;
  const dx = params.playerX - params.centerX;
  const dy = params.playerY - params.centerY;
  return dx * dx + dy * dy <= limit * limit;
}

/**
 * If `(x, y)` has BREACHED a ring wall — center distance ≥ `innerRadiusFt`,
 * only reachable via knockback tunneling since movement collision otherwise
 * keeps the center inside — pull it radially back so the whole body sits inside
 * the interior, touching the inner wall face (`innerRadiusFt − playerBodyRadiusFt`).
 * Otherwise the point is returned unchanged. Deterministic; no RNG — a plain
 * radial projection. This is the "bump him back in" safety net.
 */
export function bumpInsideRing(params: {
  readonly x: number;
  readonly y: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly innerRadiusFt: number;
  readonly playerBodyRadiusFt: number;
}): { readonly x: number; readonly y: number; readonly bumped: boolean } {
  const { x, y, centerX, centerY, innerRadiusFt, playerBodyRadiusFt } = params;
  const dx = x - centerX;
  const dy = y - centerY;
  const distSq = dx * dx + dy * dy;
  // Not breached: the center is still inside the inner edge — nothing to do.
  if (distSq < innerRadiusFt * innerRadiusFt) return { x, y, bumped: false };
  const dist = Math.sqrt(distSq);
  // Degenerate: exactly at the center (dist 0) can't be "outside"; and a ring
  // whose interior can't hold the body has nowhere valid to bump to.
  if (dist === 0) return { x, y, bumped: false };
  const target = Math.max(0, innerRadiusFt - playerBodyRadiusFt);
  const scale = target / dist;
  return { x: centerX + dx * scale, y: centerY + dy * scale, bumped: true };
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
