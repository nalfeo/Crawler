import { describe, expect, it } from 'vitest';
import {
  makeAllWallMap,
  makeDiagonalCornerMap,
  makeMapWithDoor,
  makeMapWithSafeRoom,
  makeMapWithSafeRoomDoor,
  makeOpenFloorMap,
  makePathMap,
  makeTerrainGrid,
  makeWalledMap,
} from '../helpers/map-fixtures.js';
import {
  BiomeType,
  DEFAULT_MAP_CONFIG,
  RoomRole,
  TerrainType,
  TilePresets,
} from '../../src/shared/map-types.js';

/**
 * Contract lock for the shared map fixtures. These assertions pin the exact map
 * each builder produces so a future edit to `map-fixtures.ts` that drifts from
 * the original copied-in helpers fails loudly here (not silently in a consumer).
 */

describe('makeMapWithSafeRoom', () => {
  it('defaults to the 20×20 / 32-ft single-safe-room fixture', () => {
    const map = makeMapWithSafeRoom();
    expect([map.config.widthTiles, map.config.heightTiles]).toEqual([20, 20]);
    expect(map.config.tileSizeFt).toBe(32);
    expect(map.config.maxRooms).toBe(4);
    expect(map.config.biome).toBe(BiomeType.DUNGEON);
    expect(map.config.seed).toBe(1);
    expect(map.config.floorDensity).toBe(0.5);
    expect(map.playerSpawn).toEqual({ x: 12, y: 12 });
    expect(map.terrain).toHaveLength(400);
    expect(map.terrain.every((t) => t === 0)).toBe(true);
    expect(map.tileMap.flags.every((f) => f === TilePresets.FLOOR)).toBe(true);
    expect(map.roomGraph.count).toBe(1);
    const safe = map.roomGraph.get(0)!;
    expect(safe.role).toBe(RoomRole.SAFE);
    expect(safe.bounds).toEqual({ x: 1, y: 1, width: 4, height: 4 });
  });

  it('adds a NORMAL room at (10,10) when withNormalRoom is set', () => {
    const map = makeMapWithSafeRoom({ withNormalRoom: true });
    expect(map.roomGraph.count).toBe(2);
    expect(map.roomGraph.get(0)!.role).toBe(RoomRole.SAFE);
    const normal = map.roomGraph.get(1)!;
    expect(normal.role).toBe(RoomRole.NORMAL);
    expect(normal.bounds).toEqual({ x: 10, y: 10, width: 4, height: 4 });
  });

  it('honours size/tile/maxRooms/spawn overrides (damage-branches variant)', () => {
    const map = makeMapWithSafeRoom({
      widthTiles: 12,
      heightTiles: 12,
      tileSizeFt: 4,
      maxRooms: 2,
      spawn: { x: 2, y: 2 },
    });
    expect([map.config.widthTiles, map.config.heightTiles]).toEqual([12, 12]);
    expect(map.config.tileSizeFt).toBe(4);
    expect(map.config.maxRooms).toBe(2);
    expect(map.playerSpawn).toEqual({ x: 2, y: 2 });
    expect(map.terrain).toHaveLength(144);
    expect(map.roomGraph.count).toBe(1);
  });
});

describe('makeMapWithSafeRoomDoor', () => {
  it('is a 12×12 map with a closed door wired into the safe room', () => {
    const map = makeMapWithSafeRoomDoor();
    expect([map.config.widthTiles, map.config.heightTiles]).toEqual([12, 12]);
    expect(map.config.tileSizeFt).toBe(32);
    expect(map.config.maxRooms).toBe(2);
    expect(map.playerSpawn).toEqual({ x: 2, y: 2 });
    expect(map.tileMap.flags[3 * 12 + 3]).toBe(TilePresets.DOOR_CLOSED);
    const safe = map.roomGraph.get(0)!;
    expect(safe.role).toBe(RoomRole.SAFE);
    expect(safe.doors).toEqual([{ x: 3, y: 3, connectsTo: 1 }]);
  });
});

describe('makeMapWithDoor', () => {
  it('rings a 10×10 floor in walls with a closed door at (5,5)', () => {
    const map = makeMapWithDoor();
    expect([map.config.widthTiles, map.config.heightTiles]).toEqual([10, 10]);
    expect(map.config.seed).toBe(42);
    expect(map.config.tileSizeFt).toBe(32);
    expect(map.playerSpawn).toEqual({ x: 3, y: 3 });
    expect(map.roomGraph.count).toBe(0);
    expect(map.tileMap.flags[5 * 10 + 5]).toBe(TilePresets.DOOR_CLOSED);
    // Border walls, interior floor.
    expect(map.tileMap.flags[0]).toBe(TilePresets.WALL);
    expect(map.tileMap.flags[9]).toBe(TilePresets.WALL);
    expect(map.tileMap.flags[1 * 10 + 1]).toBe(TilePresets.FLOOR);
    expect(map.tileMap.flags[8 * 10 + 8]).toBe(TilePresets.FLOOR);
  });
});

describe('makeWalledMap', () => {
  it('defaults to 32-ft tiles with a wall column at x=5', () => {
    const map = makeWalledMap();
    expect(map.config.tileSizeFt).toBe(32);
    expect(map.config.biome).toBe(BiomeType.ARENA);
    expect(map.playerSpawn).toEqual({ x: 3, y: 3 });
    // Wall column at x=5 (interior row).
    expect(map.tileMap.flags[3 * 10 + 5]).toBe(TilePresets.WALL);
    expect(map.tileMap.flags[3 * 10 + 4]).toBe(TilePresets.FLOOR);
  });

  it('supports the 4-ft variant', () => {
    expect(makeWalledMap({ tileSizeFt: 4 }).config.tileSizeFt).toBe(4);
  });
});

describe('makeDiagonalCornerMap', () => {
  it('walls the (2,1) and (1,2) corner tiles', () => {
    const map = makeDiagonalCornerMap();
    expect([map.config.widthTiles, map.config.heightTiles]).toEqual([5, 5]);
    expect(map.config.seed).toBe(42);
    expect(map.config.floorDensity).toBe(0.5);
    expect(map.tileMap.flags[1 * 5 + 2]).toBe(TilePresets.WALL);
    expect(map.tileMap.flags[2 * 5 + 1]).toBe(TilePresets.WALL);
    expect(map.tileMap.flags[1 * 5 + 1]).toBe(TilePresets.FLOOR);
  });

  it('honours seed/floorDensity overrides (behavior-tree variant)', () => {
    const map = makeDiagonalCornerMap({ seed: 1, floorDensity: 1 });
    expect(map.config.seed).toBe(1);
    expect(map.config.floorDensity).toBe(1);
  });
});

describe('makePathMap', () => {
  it('opens or closes the door at tile (6,4) per the flag', () => {
    expect(makePathMap(true).tileMap.flags[4 * 12 + 6]).toBe(TilePresets.DOOR_OPEN);
    expect(makePathMap(false).tileMap.flags[4 * 12 + 6]).toBe(TilePresets.DOOR_CLOSED);
  });

  it('builds a pillar at x=6 and defaults to 32-ft tiles', () => {
    const map = makePathMap(true);
    expect([map.config.widthTiles, map.config.heightTiles]).toEqual([12, 9]);
    expect(map.config.tileSizeFt).toBe(32);
    expect(map.playerSpawn).toEqual({ x: 2, y: 4 });
    // Pillar tile (6,1) is wall; door row (6,4) is not.
    expect(map.tileMap.flags[1 * 12 + 6]).toBe(TilePresets.WALL);
    expect(makePathMap(true, { tileSizeFt: 4 }).config.tileSizeFt).toBe(4);
  });
});

describe('makeOpenFloorMap', () => {
  it('is a 24×16 all-floor map derived from DEFAULT_MAP_CONFIG', () => {
    const map = makeOpenFloorMap();
    expect([map.config.widthTiles, map.config.heightTiles]).toEqual([24, 16]);
    expect(map.config.tileSizeFt).toBe(DEFAULT_MAP_CONFIG.tileSizeFt);
    expect(map.config.seed).toBe(DEFAULT_MAP_CONFIG.seed);
    expect(map.playerSpawn).toEqual({ x: 2, y: 5 });
    expect(map.tileMap.flags.every((f) => f === TilePresets.FLOOR)).toBe(true);
    expect(map.terrain.every((t) => t === TerrainType.STONE_FLOOR)).toBe(true);
  });

  it('carves a full-height wall column when requested', () => {
    const map = makeOpenFloorMap(5);
    for (let y = 0; y < 16; y += 1) {
      expect(map.tileMap.flags[y * 24 + 5]).toBe(TilePresets.WALL);
    }
    expect(map.tileMap.flags[0]).toBe(TilePresets.FLOOR);
  });
});

describe('makeAllWallMap', () => {
  it('returns an all-wall tile map and STONE_WALL terrain', () => {
    const { tileMap, terrain } = makeAllWallMap(6, 4);
    expect(tileMap.flags).toHaveLength(24);
    expect(tileMap.flags.every((f) => f === TilePresets.WALL)).toBe(true);
    expect(terrain.every((t) => t === TerrainType.STONE_WALL)).toBe(true);
  });
});

describe('makeTerrainGrid', () => {
  it('maps W/./space to STONE_WALL/STONE_FLOOR/VOID', () => {
    const { terrain, width, height } = makeTerrainGrid(['W.', ' W']);
    expect([width, height]).toEqual([2, 2]);
    expect(terrain[0]).toBe(TerrainType.STONE_WALL);
    expect(terrain[1]).toBe(TerrainType.STONE_FLOOR);
    expect(terrain[2]).toBe(TerrainType.VOID);
    expect(terrain[3]).toBe(TerrainType.STONE_WALL);
  });
});
