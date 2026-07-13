/**
 * Shared map fixtures for tests.
 *
 * Consolidates map-builder helpers that were copy-pasted across the suite into
 * one well-named home. Each builder reproduces its original local copy
 * **exactly** — subtle per-test differences (tile size, seed, spawn, an extra
 * room) are exposed as options so no test's map silently changes.
 *
 * Co-located with {@link ../helpers/world-factory.ts world-factory}; pair these
 * with `createTestWorld()` and assign the result to `world.floorMap`.
 */

import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  BiomeType,
  DEFAULT_MAP_CONFIG,
  RoomRole,
  TerrainType,
  TilePresets,
  type MapConfig,
} from '../../src/shared/map-types.js';

/** Tile coordinate used for a FloorMap player spawn. */
export interface TilePoint {
  readonly x: number;
  readonly y: number;
}

// ---------------------------------------------------------------------------
// Safe-room maps
// ---------------------------------------------------------------------------

export interface SafeRoomMapOptions {
  /** Map width in tiles. Default 20. */
  widthTiles?: number;
  /** Map height in tiles. Default 20. */
  heightTiles?: number;
  /** Feet per tile. Default 32. */
  tileSizeFt?: number;
  /** Max rooms (config metadata only). Default 4. */
  maxRooms?: number;
  /** Player spawn tile. Default `{ x: 12, y: 12 }`. */
  spawn?: TilePoint;
  /** Also add a NORMAL room at tiles (10,10)–(14,14). Default false. */
  withNormalRoom?: boolean;
}

/**
 * All-floor map with a single SAFE room at tiles (1,1)–(4,4).
 *
 * Defaults reproduce the 20×20 / 32-ft fixture shared by the AoE, area-damage
 * and beam branch-coverage suites. `withNormalRoom` adds the NORMAL room at
 * (10,10)–(14,14) used by `safe-room.test.ts`; the size/tile/spawn options
 * reproduce the 12×12 / 4-ft variant used by `damage-system-branches.test.ts`.
 */
export function makeMapWithSafeRoom(options: SafeRoomMapOptions = {}): FloorMap {
  const {
    widthTiles = 20,
    heightTiles = 20,
    tileSizeFt = 32,
    maxRooms = 4,
    spawn = { x: 12, y: 12 },
    withNormalRoom = false,
  } = options;

  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);

  const graph = new RoomGraph();
  graph.add({ x: 1, y: 1, width: 4, height: 4 }, [], [], RoomRole.SAFE);
  if (withNormalRoom) {
    graph.add({ x: 10, y: 10, width: 4, height: 4 }, [], [], RoomRole.NORMAL);
  }

  return new FloorMap(config, tileMap, graph, new Uint8Array(widthTiles * heightTiles), spawn);
}

/**
 * 12×12 all-floor map with a SAFE room at tiles (1,1)–(4,4) and a single closed
 * door at tile (3,3) wired into the room's door list. Reproduces the
 * `door-system-safe-room.test.ts` fixture.
 */
export function makeMapWithSafeRoomDoor(): FloorMap {
  const w = 12;
  const h = 12;
  const config: MapConfig = {
    widthTiles: w,
    heightTiles: h,
    tileSizeFt: 32,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 2,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(w, h);
  tileMap.fill(TilePresets.FLOOR);
  tileMap.flags[3 * w + 3] = TilePresets.DOOR_CLOSED;

  const graph = new RoomGraph();
  graph.add(
    { x: 1, y: 1, width: 4, height: 4 },
    [{ x: 3, y: 3, connectsTo: 1 }],
    [],
    RoomRole.SAFE,
  );

  return new FloorMap(config, tileMap, graph, new Uint8Array(w * h), { x: 2, y: 2 });
}

export interface WalledSafeRoomMapOptions {
  /** Feet per tile. Default 4. */
  tileSizeFt?: number;
  /**
   * East-wall gap tile (6,3) state: `true` = open door, `false` = closed
   * (but still legally passable to door-aware A*), `null` = no gap at all —
   * a fully sealed wall ring with no legal exit. Default `true`.
   */
  door?: boolean | null;
}

/**
 * 14×10 map with a SAFE room walled on all four sides — bounds (1,1)-(6,6),
 * so the true `RoomGraph.getRoomAt` interior (1 tile inset) is (2,2)-(5,5) —
 * and a single gap in the east wall at tile (6,3) leading into an open
 * exterior corridor (x 7-12, y 1-8). Unlike {@link makeMapWithSafeRoom} /
 * {@link makeMapWithSafeRoomDoor} (all-floor maps with no real wall
 * perimeter), this fixture has actual `WALL` tiles ringing the room so
 * door-aware A* must genuinely route through the single gap. Player spawns
 * at the room's center tile (3,3). Pass `{ door: null }` for a fully sealed
 * variant with no legal exit (the "blocked / no route" fixture). Built for
 * the safe-room route constraint suite (`safe-room-route.ts`).
 */
export function makeWalledSafeRoomMap(options: WalledSafeRoomMapOptions = {}): FloorMap {
  const { tileSizeFt = 4, door = true } = options;
  const width = 14;
  const height = 10;
  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  const doorTile = { x: 6, y: 3 };
  const tileMap = new TileMap(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const isDoorGap = door !== null && x === doorTile.x && y === doorTile.y;
      if (isDoorGap) {
        tileMap.flags[idx] = door ? TilePresets.DOOR_OPEN : TilePresets.DOOR_CLOSED;
        continue;
      }
      const isOuterBorder = x === 0 || x === width - 1 || y === 0 || y === height - 1;
      const inBoxXRange = x >= 1 && x <= 6;
      const inBoxYRange = y >= 1 && y <= 6;
      const isBoxWall =
        ((x === 1 || x === 6) && inBoxYRange) || ((y === 1 || y === 6) && inBoxXRange);
      tileMap.flags[idx] = isOuterBorder || isBoxWall ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }

  const graph = new RoomGraph();
  graph.add(
    { x: 1, y: 1, width: 6, height: 6 },
    door !== null ? [{ x: doorTile.x, y: doorTile.y, connectsTo: -1 }] : [],
    [],
    RoomRole.SAFE,
  );

  return new FloorMap(config, tileMap, graph, new Uint8Array(width * height), { x: 3, y: 3 });
}

// ---------------------------------------------------------------------------
// Door maps
// ---------------------------------------------------------------------------

/**
 * 10×10 map with a border wall ring, floor interior, and one closed door at
 * tile (5,5). Empty room graph. Reproduces the fixture shared by the
 * door-lock, door-navigation and door-system suites.
 */
export function makeMapWithDoor(): FloorMap {
  const config: MapConfig = {
    widthTiles: 10,
    heightTiles: 10,
    tileSizeFt: 32,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 2,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(10, 10);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const idx = y * 10 + x;
      tileMap.flags[idx] =
        x === 0 || x === 9 || y === 0 || y === 9 ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  tileMap.flags[5 * 10 + 5] = TilePresets.DOOR_CLOSED;

  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(100), { x: 3, y: 3 });
}

// ---------------------------------------------------------------------------
// Walled / arena maps
// ---------------------------------------------------------------------------

export interface WalledMapOptions {
  /** Feet per tile. Default 32 (use 4 for the ability-system fixture). */
  tileSizeFt?: number;
}

/**
 * 10×10 ARENA map walled on the border with an extra full-height wall column at
 * x=5. Defaults to 32-ft tiles (movement + knockback suites); pass
 * `{ tileSizeFt: 4 }` for the ability-system fixture.
 */
export function makeWalledMap(options: WalledMapOptions = {}): FloorMap {
  const { tileSizeFt = 32 } = options;
  const config: MapConfig = {
    widthTiles: 10,
    heightTiles: 10,
    tileSizeFt,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(10, 10);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const idx = y * 10 + x;
      tileMap.flags[idx] =
        x === 0 || x === 9 || y === 0 || y === 9 || x === 5 ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }

  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(100), { x: 3, y: 3 });
}

export interface DiagonalCornerMapOptions {
  /** Generation seed (config metadata only). Default 42. */
  seed?: number;
  /** Floor density (config metadata only). Default 0.5. */
  floorDensity?: number;
}

/**
 * 5×5 / 4-ft ARENA map, all floor except walls at (2,1) and (1,2) — a diagonal
 * "corner" pinch used to assert diagonal-move blocking. Defaults reproduce the
 * `movement.test.ts` copy; pass `{ seed: 1, floorDensity: 1 }` for the
 * `behavior-tree-ai.test.ts` copy.
 */
export function makeDiagonalCornerMap(options: DiagonalCornerMapOptions = {}): FloorMap {
  const { seed = 42, floorDensity = 0.5 } = options;
  const config: MapConfig = {
    widthTiles: 5,
    heightTiles: 5,
    tileSizeFt: 4,
    biome: BiomeType.ARENA,
    seed,
    roomWidthRange: [3, 5],
    roomHeightRange: [3, 5],
    maxRooms: 1,
    floorDensity,
  };

  const tileMap = new TileMap(5, 5);
  tileMap.fill(TilePresets.FLOOR);
  tileMap.setFlags(2, 1, TilePresets.WALL);
  tileMap.setFlags(1, 2, TilePresets.WALL);

  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(25), { x: 1, y: 1 });
}

export interface PathMapOptions {
  /** Feet per tile. Default 32 (use 4 for the flow-field fixture). */
  tileSizeFt?: number;
}

/**
 * 12×9 ARENA map split by a full-height pillar at x=6, pierced only by a door at
 * tile (6,4) that is open or closed per `doorOpen`. Shared by the pathfinding
 * and flow-field suites — defaults to 32-ft tiles (pathfinding); pass
 * `{ tileSizeFt: 4 }` for the flow-field copy.
 */
export function makePathMap(doorOpen: boolean, options: PathMapOptions = {}): FloorMap {
  const { tileSizeFt = 32 } = options;
  const width = 12;
  const height = 9;
  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const isPillar = x === 6 && y >= 1 && y <= height - 2 && y !== 4;
      tileMap.flags[idx] = isBorder || isPillar ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  tileMap.flags[4 * width + 6] = doorOpen ? TilePresets.DOOR_OPEN : TilePresets.DOOR_CLOSED;

  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(width * height), {
    x: 2,
    y: 4,
  });
}

/**
 * 24×16 open map derived from {@link DEFAULT_MAP_CONFIG}, all floor with
 * STONE_FLOOR terrain. An optional full-height wall column at `wallColumnX`
 * splits it for line-of-sight gating tests. Reproduces the identical
 * `makeFloorMap` / `makeOpenFloorMap` helpers from the melee-returning and
 * weapon-system coverage suites.
 */
export function makeOpenFloorMap(wallColumnX?: number): FloorMap {
  const widthTiles = 24;
  const heightTiles = 16;
  const config: MapConfig = { ...DEFAULT_MAP_CONFIG, widthTiles, heightTiles };

  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);
  if (wallColumnX !== undefined) {
    for (let y = 0; y < heightTiles; y += 1) {
      tileMap.setFlags(wallColumnX, y, TilePresets.WALL);
    }
  }

  const terrain = new Uint8Array(widthTiles * heightTiles);
  terrain.fill(TerrainType.STONE_FLOOR);

  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 2, y: 5 });
}

// ---------------------------------------------------------------------------
// Raw tile/terrain grids (not full FloorMaps)
// ---------------------------------------------------------------------------

/**
 * Build an all-wall `TileMap` + STONE_WALL terrain of the given tile size,
 * ready for a generator test to carve rooms/corridors into. Reproduces the
 * `makeMap(w, h)` helper from `ensure-rooms-reachable.test.ts`.
 */
export function makeAllWallMap(w: number, h: number): { tileMap: TileMap; terrain: Uint8Array } {
  const tileMap = new TileMap(w, h);
  tileMap.flags.fill(TilePresets.WALL);
  const terrain = new Uint8Array(w * h).fill(TerrainType.STONE_WALL);
  return { tileMap, terrain };
}

/**
 * Build a flat terrain array from a 2-D string grid:
 * `'W'` = STONE_WALL, `'.'` = STONE_FLOOR, anything else = VOID. Reproduces the
 * `makeMap(rows)` helper from `tile-visuals.test.ts`.
 */
export function makeTerrainGrid(rows: readonly string[]): {
  terrain: Uint8Array;
  width: number;
  height: number;
} {
  const height = rows.length;
  const width = rows[0]!.length;
  const terrain = new Uint8Array(width * height);
  for (let ty = 0; ty < height; ty += 1) {
    for (let tx = 0; tx < width; tx += 1) {
      const ch = rows[ty]![tx];
      if (ch === 'W') terrain[ty * width + tx] = TerrainType.STONE_WALL;
      else if (ch === '.') terrain[ty * width + tx] = TerrainType.STONE_FLOOR;
      else terrain[ty * width + tx] = TerrainType.VOID;
    }
  }
  return { terrain, width, height };
}
