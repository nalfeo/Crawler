/**
 * Barrier ring geometry — enumerate the tiles that form a circular fence
 * around a centre point.
 *
 * Pure geometry: no ECS, no `TileMap.flags` mutation, no dependency on tile
 * passability. That is deliberate — the "old" fence approach (`spawner-arena.ts`
 * pre-refactor) skipped currently-impassable tiles at snapshot time, which
 * meant a spawner whose ring happened to overlap walls produced an
 * incomplete cage. Barriers are an overlay, so a ring tile that happens to
 * coincide with a wall stays in the barrier set — the wall+barrier double
 * covering it costs nothing and guarantees a closed loop.
 *
 * @remarks
 * A tile counts as "on the ring" when its centre is within one half-tile of
 * the arena radius (distance ∈ (r - halfTile, r + halfTile]). The result is
 * always in deterministic row-major order — same seed, same tiles, same order
 * — so replay determinism holds.
 */
import type { FloorMap } from '../map/FloorMap.js';

/**
 * True iff a world-space (feet) point lies within the circular wall band
 * `[innerRadiusFt, outerRadiusFt]` centred on `(cxFt, cyFt)`. Inclusive on
 * both edges. Pure geometry — no ECS, no tile grid — so a 1 ft-thick wall
 * blocks at exact sub-tile precision instead of snapping to 4 ft tiles.
 *
 * Uses squared distances (no `sqrt`) — this is called per movement step for
 * every entity while an arena is active, so it must stay allocation- and
 * transcendental-free.
 */
export function pointInRingBand(
  cxFt: number,
  cyFt: number,
  innerRadiusFt: number,
  outerRadiusFt: number,
  xFt: number,
  yFt: number,
): boolean {
  const dx = xFt - cxFt;
  const dy = yFt - cyFt;
  const distSq = dx * dx + dy * dy;
  const innerSq = innerRadiusFt * innerRadiusFt;
  const outerSq = outerRadiusFt * outerRadiusFt;
  return distSq >= innerSq && distSq <= outerSq;
}

/**
 * True iff the circular wall band `[innerRadiusFt, outerRadiusFt]` centred on
 * `(cxFt, cyFt)` intersects the axis-aligned rectangle
 * `[minXFt, maxXFt] × [minYFt, maxYFt]` (feet). Inclusive on all edges.
 *
 * Existence of this test — rather than point sampling — is a correctness
 * requirement for any TILE-granular consumer of an analytic ring wall. A ring
 * wall can be thinner than a tile (the spawner arena raises a 1 ft band on a
 * 4 ft grid), so it can pass cleanly BETWEEN two adjacent tile centres without
 * either centre lying inside the band. Sampling only centres therefore reports
 * a walkable transition straight through a physically sealed cage.
 *
 * The rectangle is connected and distance-to-centre is continuous on it, so
 * the set of distances realised on the rectangle is exactly
 * `[minDist, maxDist]`. The band intersects the rectangle iff that interval
 * overlaps `[innerRadiusFt, outerRadiusFt]` — this test is therefore exact,
 * not merely conservative. Squared distances only (no `sqrt`).
 */
export function ringBandIntersectsRect(
  cxFt: number,
  cyFt: number,
  innerRadiusFt: number,
  outerRadiusFt: number,
  minXFt: number,
  minYFt: number,
  maxXFt: number,
  maxYFt: number,
): boolean {
  // Nearest point of the rect to the centre (clamped), and its squared distance.
  const nearestX = Math.min(Math.max(cxFt, minXFt), maxXFt);
  const nearestY = Math.min(Math.max(cyFt, minYFt), maxYFt);
  const nearDx = nearestX - cxFt;
  const nearDy = nearestY - cyFt;
  const minDistSq = nearDx * nearDx + nearDy * nearDy;

  // Farthest point is always a corner: take the larger span on each axis.
  const farDx = Math.max(Math.abs(minXFt - cxFt), Math.abs(maxXFt - cxFt));
  const farDy = Math.max(Math.abs(minYFt - cyFt), Math.abs(maxYFt - cyFt));
  const maxDistSq = farDx * farDx + farDy * farDy;

  const innerSq = innerRadiusFt * innerRadiusFt;
  const outerSq = outerRadiusFt * outerRadiusFt;
  return minDistSq <= outerSq && maxDistSq >= innerSq;
}

/**
 * Enumerate tile indices that lie on a circular ring around `(cxFt, cyFt)`.
 * Returned in deterministic row-major order.
 *
 * Unlike the old `collectFenceRingTiles`, this helper is INDEPENDENT of
 * `TileMap.isPassable` — barriers overlay tiles regardless of underlying
 * passability, so a ring tile that happens to sit on a wall is still added.
 * Door tiles are excluded because doors have their own lock semantics.
 *
 * NOTE: this tile-based ring is used only by `createRingBarrier` (the blocky
 * tile-ring utility exercised by the barrier lab). The spawner arena's
 * open-fence cage does NOT use it — that path raises the analytic
 * {@link createRingWallBarrier}, a gapless 1 ft-thick circle queried at feet
 * precision, so no doorway seam can open regardless of this door-skip.
 */
export function collectRingTiles(params: {
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
      // Door tiles have their own lock semantics — a barrier over a door
      // tile would fight the door system. Callers that want doorway-guards
      // use `collectRoomDoorwayTiles` explicitly.
      if (tileMap.isDoor(tx, ty)) continue;
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
 * Enumerate the tile indices covering each doorway of a room.
 *
 * The spawner arena's sealed-room path uses this as a belt-and-suspenders
 * guard alongside the existing door-lock config: even if the door somehow
 * opens (script bug, unlock predicate misfire), the barrier tile physically
 * plugs the doorway.
 */
export function collectRoomDoorwayTiles(params: {
  readonly floorMap: FloorMap;
  readonly roomId: number;
}): number[] {
  const room = params.floorMap.roomGraph.get(params.roomId);
  if (!room) return [];
  const { tileMap } = params.floorMap;
  const tiles: number[] = [];
  for (const door of room.doors) {
    if (!tileMap.inBounds(door.x, door.y)) continue;
    tiles.push(tileMap.index(door.x, door.y));
  }
  return tiles;
}

/**
 * Enumerate the interior tiles of a room — every tile inside `room.bounds`.
 * Used by `createRoomBarrier(..., { doorwaysOnly: false })` to flood-fill a
 * room's interior with a barrier (e.g. a boss forcefield that makes the whole
 * room floor solid).
 *
 * NOTE: this returns interior tiles ONLY. `room.bounds` excludes the perimeter
 * wall row/column, so the returned set does NOT include the perimeter walls or
 * the doorway tiles that sit on that perimeter. A caller that needs to seal a
 * room's exits must also plug those explicitly (see
 * {@link collectRoomDoorwayTiles}). Currently unused inside the spawner arena,
 * but exposed because rule 12 requires the primitive to support any system's
 * future needs.
 */
export function collectRoomInteriorTiles(params: {
  readonly floorMap: FloorMap;
  readonly roomId: number;
}): number[] {
  const room = params.floorMap.roomGraph.get(params.roomId);
  if (!room) return [];
  const { tileMap } = params.floorMap;
  const tiles: number[] = [];
  const { x: rx, y: ry, width, height } = room.bounds;
  for (let ty = ry; ty < ry + height; ty += 1) {
    for (let tx = rx; tx < rx + width; tx += 1) {
      if (!tileMap.inBounds(tx, ty)) continue;
      tiles.push(tileMap.index(tx, ty));
    }
  }
  return tiles;
}
