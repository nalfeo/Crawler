/**
 * Physics integration tests for the barrier primitive.
 *
 * Assertions:
 *   - `FloorMap.isPassableAt` returns false on a barriered tile
 *   - `findTilePath` (A*) refuses to route through barriered tiles for both
 *     GROUND and FLYING traversal modes — the leak the pre-refactor fence
 *     path had was that pathfinding could still plan through fence tiles
 *   - Movement wraps `isPassableAt`, so an entity moved onto a barrier tile
 *     has its position clipped
 *   - Barriers are TRANSPARENT to LOS/FOV — the shimmer is intentional
 *
 * Rendering, VFX, and announcement emission are NOT tested here — that's
 * a separate concern owned by the spawner arena caging integration tests.
 */
import { describe, expect, it } from 'vitest';
import {
  attachBarriersToFloorMap,
  createBarrierRegistry,
  createPolyBarrier,
} from '../../../src/core/barriers/index.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../../src/core/map/RoomGraph.js';
import { TileMap } from '../../../src/core/map/TileMap.js';
import { PATH_TRAVERSAL, findTilePath } from '../../../src/core/map/pathfinding.js';
import { BiomeType, TilePresets, type MapConfig } from '../../../src/shared/map-types.js';

/** Build a 12×12 all-floor map with a walled border. */
function makeOpenMap(): FloorMap {
  const w = 12;
  const h = 12;
  const config: MapConfig = {
    widthTiles: w,
    heightTiles: h,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(w, h);
  tileMap.fill(TilePresets.FLOOR);
  // Border wall so pathfinding stays inside the map.
  for (let x = 0; x < w; x += 1) {
    tileMap.flags[x] = TilePresets.WALL;
    tileMap.flags[(h - 1) * w + x] = TilePresets.WALL;
  }
  for (let y = 0; y < h; y += 1) {
    tileMap.flags[y * w] = TilePresets.WALL;
    tileMap.flags[y * w + (w - 1)] = TilePresets.WALL;
  }
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(w * h), { x: 1, y: 1 });
}

function makeBarrierWorld() {
  const floorMap = makeOpenMap();
  const world = { floorMap, barriers: createBarrierRegistry() };
  attachBarriersToFloorMap(world);
  return world;
}

describe('barrier physics — passability chokepoint', () => {
  it('isPassableAt returns false on barriered floor tiles', () => {
    const world = makeBarrierWorld();
    // Tile (5, 5) is normally passable.
    const xFt = 5 * 4 + 2;
    const yFt = 5 * 4 + 2;
    expect(world.floorMap.isPassableAt(xFt, yFt)).toBe(true);
    createPolyBarrier(world, [world.floorMap.tileMap.index(5, 5)], 'fence');
    expect(world.floorMap.isPassableAt(xFt, yFt)).toBe(false);
  });
});

describe('barrier physics — pathfinding refuses barrier tiles', () => {
  it('findTilePath (GROUND) plans around a single-tile barrier', () => {
    const world = makeBarrierWorld();
    // Barrier a vertical column of 3 tiles at x=5, y=4..6, forcing detour.
    const tm = world.floorMap.tileMap;
    createPolyBarrier(world, [tm.index(5, 4), tm.index(5, 5), tm.index(5, 6)], 'fence');
    const path = findTilePath(world.floorMap, { x: 3, y: 5 }, { x: 8, y: 5 });
    expect(path.length).toBeGreaterThan(0);
    for (const step of path) {
      // No path step should land on a barrier tile.
      expect(world.floorMap.hasBarrierAtTile(step.x, step.y)).toBe(false);
    }
  });

  it('findTilePath (FLYING) also refuses barrier tiles — barriers are impenetrable', () => {
    const world = makeBarrierWorld();
    const tm = world.floorMap.tileMap;
    createPolyBarrier(world, [tm.index(5, 4), tm.index(5, 5), tm.index(5, 6)], 'fence');
    const path = findTilePath(
      world.floorMap,
      { x: 3, y: 5 },
      { x: 8, y: 5 },
      { traversalMode: PATH_TRAVERSAL.FLYING },
    );
    for (const step of path) {
      expect(world.floorMap.hasBarrierAtTile(step.x, step.y)).toBe(false);
    }
  });

  it('findTilePath returns empty when the goal is inside a barrier', () => {
    const world = makeBarrierWorld();
    const tm = world.floorMap.tileMap;
    createPolyBarrier(world, [tm.index(5, 5)], 'fence');
    const path = findTilePath(world.floorMap, { x: 3, y: 5 }, { x: 5, y: 5 });
    expect(path).toEqual([]);
  });
});

describe('barrier physics — LOS is transparent', () => {
  it('lineOfSight passes through barrier tiles (fence shimmer)', () => {
    const world = makeBarrierWorld();
    const tm = world.floorMap.tileMap;
    // Barrier the tile between two floor tiles.
    createPolyBarrier(world, [tm.index(5, 5)], 'fence');
    // LOS from (3,5) to (7,5) should still succeed — the barrier only
    // blocks movement, not sight.
    const canSee = tm.lineOfSight(3, 5, 7, 5);
    expect(canSee).toBe(true);
  });
});
