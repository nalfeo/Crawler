/**
 * Unit tests for the dynamic barrier registry.
 *
 * Covers:
 *   - create/drop lifecycle (id monotonicity, version bumping)
 *   - `blockedTiles` is an exact union of live-barrier tile sets
 *   - `createRingBarrier` produces a symmetric ring INDEPENDENT of tile
 *     passability — the class of leak that motivated ADR 0046
 *   - `createRoomBarrier({ doorwaysOnly: true })` paints only doorway tiles
 *   - overlapping barriers keep tiles blocked while any handle references them
 *
 * These tests build a hand-crafted FloorMap so they can exercise the mixed
 * wall+floor ring case that used to leak with the pre-refactor
 * `collectFenceRingTiles` implementation.
 */
import { describe, expect, it } from 'vitest';
import {
  attachBarriersToFloorMap,
  createBarrierRegistry,
  createPolyBarrier,
  createRingBarrier,
  createRoomBarrier,
  dropBarrier,
  isBarrierTile,
} from '../../../src/core/barriers/index.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../../src/core/map/RoomGraph.js';
import { TileMap } from '../../../src/core/map/TileMap.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../../src/shared/map-types.js';

/** Build a 20×20 map with a single 8×8 walled room + one door. */
function makeRoomMap(): FloorMap {
  const w = 20;
  const h = 20;
  const config: MapConfig = {
    widthTiles: w,
    heightTiles: h,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 2,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(w, h);
  tileMap.fill(TilePresets.FLOOR);
  // Outer border wall.
  for (let x = 0; x < w; x += 1) {
    tileMap.flags[x] = TilePresets.WALL;
    tileMap.flags[(h - 1) * w + x] = TilePresets.WALL;
  }
  for (let y = 0; y < h; y += 1) {
    tileMap.flags[y * w] = TilePresets.WALL;
    tileMap.flags[y * w + (w - 1)] = TilePresets.WALL;
  }
  // Inner walled room at tiles (6,6)–(13,13) with one door at (10, 6).
  for (let x = 6; x <= 13; x += 1) {
    tileMap.flags[6 * w + x] = TilePresets.WALL;
    tileMap.flags[13 * w + x] = TilePresets.WALL;
  }
  for (let y = 6; y <= 13; y += 1) {
    tileMap.flags[y * w + 6] = TilePresets.WALL;
    tileMap.flags[y * w + 13] = TilePresets.WALL;
  }
  tileMap.flags[6 * w + 10] = TilePresets.DOOR_CLOSED;

  const graph = new RoomGraph();
  graph.add(
    { x: 7, y: 7, width: 6, height: 6 },
    [{ x: 10, y: 6, connectsTo: -1 }],
    [],
    RoomRole.NORMAL,
  );
  return new FloorMap(config, tileMap, graph, new Uint8Array(w * h), { x: 8, y: 8 });
}

/** Minimal `BarrierWorld` shape for tests. */
function makeBarrierWorld(floorMap: FloorMap | null = null) {
  const world = {
    floorMap,
    barriers: createBarrierRegistry(),
  };
  if (floorMap) attachBarriersToFloorMap(world);
  return world;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('barrier registry lifecycle', () => {
  it('starts empty with version 0 and a monotonic nextId', () => {
    const registry = createBarrierRegistry();
    expect(registry.barriers.size).toBe(0);
    expect(registry.blockedTiles.size).toBe(0);
    expect(registry.version).toBe(0);
    expect(registry.nextId).toBe(1);
  });

  it('bumps version on every mutation (create + drop)', () => {
    const world = makeBarrierWorld(makeRoomMap());
    const v0 = world.barriers.version;
    const handle = createPolyBarrier(world, [1, 2, 3], 'fence');
    expect(world.barriers.version).toBe(v0 + 1);
    dropBarrier(world, handle);
    expect(world.barriers.version).toBe(v0 + 2);
  });

  it('assigns non-reused monotonic ids', () => {
    const world = makeBarrierWorld(makeRoomMap());
    const a = createPolyBarrier(world, [1], 'fence');
    const b = createPolyBarrier(world, [2], 'fence');
    dropBarrier(world, a);
    const c = createPolyBarrier(world, [3], 'fence');
    expect(a.id).toBeLessThan(b.id);
    expect(b.id).toBeLessThan(c.id);
    expect(c.id).not.toBe(a.id);
  });

  it('dropping an unknown handle is a no-op (idempotent)', () => {
    const world = makeBarrierWorld(makeRoomMap());
    const before = world.barriers.version;
    dropBarrier(world, { id: 9999, kind: 'fence', tiles: [1] });
    expect(world.barriers.version).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// blockedTiles union
// ---------------------------------------------------------------------------

describe('blockedTiles union', () => {
  it("is the exact union of every live barrier's tiles", () => {
    const world = makeBarrierWorld(makeRoomMap());
    const a = createPolyBarrier(world, [10, 11, 12], 'fence');
    const b = createPolyBarrier(world, [12, 13, 14], 'fence');
    expect([...world.barriers.blockedTiles].sort((x, y) => x - y)).toEqual([10, 11, 12, 13, 14]);
    // Dropping `a` keeps tile 12 blocked because `b` still references it.
    dropBarrier(world, a);
    expect([...world.barriers.blockedTiles].sort((x, y) => x - y)).toEqual([12, 13, 14]);
    // Dropping `b` clears everything.
    dropBarrier(world, b);
    expect(world.barriers.blockedTiles.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ring geometry — the leak-class this primitive exists to fix
// ---------------------------------------------------------------------------

describe('createRingBarrier', () => {
  it('emits a symmetric ring around the centre in feet', () => {
    const world = makeBarrierWorld(makeRoomMap());
    const cxFt = 10 * 4; // tile (10,10), floor space
    const cyFt = 10 * 4;
    const handle = createRingBarrier(world, cxFt, cyFt, 8, 'fence');
    expect(handle.tiles.length).toBeGreaterThan(0);
    // Every returned tile lies at ring distance (r ± halfTile) from centre.
    for (const idx of handle.tiles) {
      const tx = idx % world.floorMap!.width;
      const ty = Math.floor(idx / world.floorMap!.width);
      const cxTx = tx * 4 + 2;
      const cyTy = ty * 4 + 2;
      const dist = Math.hypot(cxTx - cxFt, cyTy - cyFt);
      expect(dist).toBeGreaterThanOrEqual(6); // r - halfTile
      expect(dist).toBeLessThanOrEqual(10 + 0.01); // r + halfTile, small fp slop
    }
  });

  it('is passability-agnostic: a ring that intersects walls still includes those tiles', () => {
    // The pre-refactor helper skipped currently-impassable tiles. That
    // dropped the wall tiles out of the fence set, producing a leaky cage.
    // The new helper must INCLUDE the wall tiles — the barrier+wall double
    // covering them is safe.
    const world = makeBarrierWorld(makeRoomMap());
    // Centre the ring on a wall tile (row 6 is the room's top wall).
    const cxFt = 10 * 4;
    const cyFt = 6 * 4;
    const handle = createRingBarrier(world, cxFt, cyFt, 8, 'fence');
    // At least one ring tile should sit ON a wall — that's the whole point.
    let hitWall = false;
    for (const idx of handle.tiles) {
      const tx = idx % world.floorMap!.width;
      const ty = Math.floor(idx / world.floorMap!.width);
      if (!world.floorMap!.tileMap.isPassable(tx, ty)) {
        hitWall = true;
        break;
      }
    }
    expect(hitWall).toBe(true);
  });

  it('registers ring tiles in `blockedTiles` — physics chokepoint sees them', () => {
    const world = makeBarrierWorld(makeRoomMap());
    const handle = createRingBarrier(world, 40, 40, 8, 'fence');
    for (const idx of handle.tiles) {
      expect(isBarrierTile(world, idx)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Room barriers
// ---------------------------------------------------------------------------

describe('createRoomBarrier', () => {
  it('doorwaysOnly (default) covers exactly the doorway tiles of the room', () => {
    const world = makeBarrierWorld(makeRoomMap());
    const handle = createRoomBarrier(world, 0, 'fence');
    // Room built above has one door at (10, 6) — that tile in the flat array.
    const tm = world.floorMap!.tileMap;
    const doorIdx = tm.index(10, 6);
    expect(handle.tiles).toEqual([doorIdx]);
  });

  it('doorwaysOnly: false covers every interior tile of the room', () => {
    const world = makeBarrierWorld(makeRoomMap());
    const handle = createRoomBarrier(world, 0, 'fence', { doorwaysOnly: false });
    // Room bounds are 6×6 = 36 tiles.
    expect(handle.tiles.length).toBe(36);
  });

  it('unknown room id → empty tile list, no crash', () => {
    const world = makeBarrierWorld(makeRoomMap());
    const handle = createRoomBarrier(world, 999, 'fence');
    expect(handle.tiles).toEqual([]);
    expect(world.barriers.blockedTiles.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isBarrierTile through FloorMap.isPassableAt
// ---------------------------------------------------------------------------

describe('barrier ↔ FloorMap.isPassableAt integration', () => {
  it('isPassableAt returns false on a barriered tile even if the tile flag says PASSABLE', () => {
    const world = makeBarrierWorld(makeRoomMap());
    // Pick a plainly-passable floor tile.
    const tx = 3;
    const ty = 3;
    expect(world.floorMap!.tileMap.isPassable(tx, ty)).toBe(true);
    // World-space centre of that tile.
    const xFt = tx * 4 + 2;
    const yFt = ty * 4 + 2;
    expect(world.floorMap!.isPassableAt(xFt, yFt)).toBe(true);
    // Now barrier it and verify the flip.
    const handle = createPolyBarrier(world, [world.floorMap!.tileMap.index(tx, ty)], 'fence');
    expect(world.floorMap!.isPassableAt(xFt, yFt)).toBe(false);
    dropBarrier(world, handle);
    expect(world.floorMap!.isPassableAt(xFt, yFt)).toBe(true);
  });
});
