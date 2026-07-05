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
 * Enumerate tile indices that lie on a circular ring around `(cxFt, cyFt)`.
 * Returned in deterministic row-major order.
 *
 * Unlike the old `collectFenceRingTiles`, this helper is INDEPENDENT of
 * `TileMap.isPassable` — barriers overlay tiles regardless of underlying
 * passability, so a ring tile that happens to sit on a wall is still added.
 * Door tiles are excluded because doors have their own lock semantics; the
 * caller (e.g. spawnerArenaSystem) uses {@link collectRoomDoorwayTiles} for
 * those.
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
 * Enumerate every interior tile of a room. Used by
 * `createRoomBarrier(..., { doorwaysOnly: false })` to encase the whole room
 * in a barrier — e.g. a boss forcefield that seals both walls AND doorways.
 * Currently unused inside the spawner arena, but exposed because rule 12
 * requires the primitive to support any system's future needs.
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
