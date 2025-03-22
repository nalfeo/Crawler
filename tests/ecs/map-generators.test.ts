import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../../src/shared/random';
import { BiomeType, TileFlags, RoomRole, TerrainType } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import {
  DungeonGenerator,
  SPECIAL_ROOM_MIN_WIDTH,
  SPECIAL_ROOM_MIN_HEIGHT,
} from '../../src/core/map/generators/DungeonGenerator';
import { CaveGenerator } from '../../src/core/map/generators/CaveGenerator';
import { ArenaGenerator } from '../../src/core/map/generators/ArenaGenerator';
import { getGenerator, getRegisteredBiomes } from '../../src/core/map/generators/registry';
import type { FloorMap } from '../../src/core/map/FloorMap';

type GeneratedFloor = ReturnType<DungeonGenerator['generate']>;
type GeneratedRoom = GeneratedFloor['rooms'][number];
type GeneratedDoor = GeneratedRoom['doors'][number];

/** Small map config for fast test generation. */
function smallConfig(biome: BiomeType): MapConfig {
  return {
    widthTiles: 60,
    heightTiles: 40,
    tileSizeFt: 4,
    biome,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 10,
    floorDensity: 0.3,
  };
}

function hasReachableInteriorTile(
  floor: GeneratedFloor,
  room: GeneratedRoom,
  door: GeneratedDoor,
): boolean {
  const { x, y, width, height } = room.bounds;
  const adjacentInteriorTiles: ReadonlyArray<readonly [number, number]> = [
    [door.x - 1, door.y],
    [door.x + 1, door.y],
    [door.x, door.y - 1],
    [door.x, door.y + 1],
  ];
  return adjacentInteriorTiles.some(
    ([tx, ty]) =>
      tx > x &&
      tx < x + width - 1 &&
      ty > y &&
      ty < y + height - 1 &&
      floor.tileMap.isPassable(tx, ty),
  );
}

function connectedRoomIds(startId: number, rooms: readonly GeneratedRoom[]): Set<number> {
  const visited = new Set<number>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const roomId = queue.shift()!;
    for (const neighbor of rooms[roomId]?.neighbors ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }
  return visited;
}

function getDoorSide(
  room: GeneratedRoom,
  door: GeneratedDoor,
): 'left' | 'right' | 'top' | 'bottom' | null {
  const { x, y, width, height } = room.bounds;
  if (door.x === x) return 'left';
  if (door.x === x + width - 1) return 'right';
  if (door.y === y) return 'top';
  if (door.y === y + height - 1) return 'bottom';
  return null;
}

function countAdjacentDoorPairs(floor: GeneratedFloor): number {
  let pairs = 0;
  for (const room of floor.rooms) {
    const doorSet = new Set(room.doors.map((door) => `${door.x},${door.y}`));
    for (const door of room.doors) {
      const side = getDoorSide(room, door);
      if ((side === 'left' || side === 'right') && doorSet.has(`${door.x},${door.y + 1}`)) {
        pairs += 1;
      }
      if ((side === 'top' || side === 'bottom') && doorSet.has(`${door.x + 1},${door.y}`)) {
        pairs += 1;
      }
    }
  }
  return pairs;
}

/**
 * Flood-fill from the player spawn treating PASSABLE tiles and DOOR tiles as
 * walkable. Returns the set of tile indices that are reachable.
 */
function reachableTileIndices(floor: FloorMap): Set<number> {
  const { width: w, height: h, playerSpawn, tileMap } = floor;
  const visited = new Set<number>();
  const stack: number[] = [playerSpawn.y * w + playerSpawn.x];
  visited.add(stack[0]!);

  while (stack.length > 0) {
    const idx = stack.pop()!;
    const cx = idx % w;
    const cy = (idx - cx) / w;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited.has(nIdx)) continue;
      const flags = tileMap.flags[nIdx]!;
      const isDoor = (flags & TileFlags.DOOR) !== 0;
      const isPassable = (flags & TileFlags.PASSABLE) !== 0;
      if (!isPassable && !isDoor) continue;
      visited.add(nIdx);
      stack.push(nIdx);
    }
  }
  return visited;
}

describe('Map Generators', () => {
  describe('DungeonGenerator', () => {
    it('should produce a map with correct dimensions', () => {
      const gen = new DungeonGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.DUNGEON), rng);

      expect(floor.width).toBe(60);
      expect(floor.height).toBe(40);
      expect(floor.flags.length).toBe(60 * 40);
      expect(floor.terrain.length).toBe(60 * 40);
    });

    it('should produce at least one room', () => {
      const gen = new DungeonGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.DUNGEON), rng);

      expect(floor.rooms.length).toBeGreaterThanOrEqual(1);
    });

    it('should have a passable player spawn', () => {
      const gen = new DungeonGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.DUNGEON), rng);

      expect(floor.tileMap.isPassable(floor.playerSpawn.x, floor.playerSpawn.y)).toBe(true);
    });

    it('should produce deterministic output for same seed', () => {
      const gen = new DungeonGenerator();
      const config = smallConfig(BiomeType.DUNGEON);

      const floor1 = gen.generate(config, new SeededRandom(42));
      const floor2 = gen.generate(config, new SeededRandom(42));

      expect(Array.from(floor1.flags)).toEqual(Array.from(floor2.flags));
      expect(floor1.rooms.length).toBe(floor2.rooms.length);
    });

    it('should tag spawn room with SPAWN role', () => {
      const gen = new DungeonGenerator();
      const floor = gen.generate(smallConfig(BiomeType.DUNGEON), new SeededRandom(42));

      if (floor.rooms.length >= 1) {
        expect(floor.spawnRoom).toBeDefined();
        expect(floor.spawnRoom!.role).toBe(RoomRole.SPAWN);
      }
    });

    it('should tag exactly one BOSS_STAIR room when >= 2 rooms', () => {
      const gen = new DungeonGenerator();
      const floor = gen.generate(smallConfig(BiomeType.DUNGEON), new SeededRandom(42));

      if (floor.rooms.length >= 2) {
        expect(floor.bossStairRoom).toBeDefined();
        const bossRooms = floor.rooms.filter((r) => r.role === RoomRole.BOSS_STAIR);
        expect(bossRooms).toHaveLength(1);
      }
    });

    it('should tag exactly one SAFE room when >= 3 rooms', () => {
      const gen = new DungeonGenerator();
      const floor = gen.generate(smallConfig(BiomeType.DUNGEON), new SeededRandom(42));

      if (floor.rooms.length >= 3) {
        expect(floor.safeRoom).toBeDefined();
        const safeRooms = floor.rooms.filter((r) => r.role === RoomRole.SAFE);
        expect(safeRooms).toHaveLength(1);
      }
    });

    it('should have both floor and wall tiles', () => {
      const gen = new DungeonGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.DUNGEON), rng);

      let floors = 0;
      let walls = 0;
      for (let i = 0; i < floor.flags.length; i++) {
        if ((floor.flags[i]! & TileFlags.PASSABLE) !== 0) floors++;
        else walls++;
      }
      expect(floors).toBeGreaterThan(0);
      expect(walls).toBeGreaterThan(0);
    });
  });

  describe('DungeonGenerator (BASIC_UNDERGROUND — room variety)', () => {
    /** Seeds used across multiple regression tests in this suite. */
    const REGRESSION_TEST_SEEDS = [1, 2, 3, 5, 7, 10, 42, 99] as const;
    it('should produce a map with correct dimensions', () => {
      const gen = new DungeonGenerator({ roomVariety: true });
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.BASIC_UNDERGROUND), rng);

      expect(floor.width).toBe(60);
      expect(floor.height).toBe(40);
    });

    it('should have a passable player spawn', () => {
      const gen = new DungeonGenerator({ roomVariety: true });
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.BASIC_UNDERGROUND), rng);

      expect(floor.tileMap.isPassable(floor.playerSpawn.x, floor.playerSpawn.y)).toBe(true);
    });

    it('should produce deterministic output for same seed', () => {
      const gen = new DungeonGenerator({ roomVariety: true });
      const config = smallConfig(BiomeType.BASIC_UNDERGROUND);

      const floor1 = gen.generate(config, new SeededRandom(99));
      const floor2 = gen.generate(config, new SeededRandom(99));

      expect(Array.from(floor1.flags)).toEqual(Array.from(floor2.flags));
      expect(floor1.rooms.length).toBe(floor2.rooms.length);
    });

    it('should produce at least one room', () => {
      const gen = new DungeonGenerator({ roomVariety: true });
      const floor = gen.generate(smallConfig(BiomeType.BASIC_UNDERGROUND), new SeededRandom(42));

      expect(floor.rooms.length).toBeGreaterThanOrEqual(1);
    });

    it('should have both floor and wall tiles', () => {
      const gen = new DungeonGenerator({ roomVariety: true });
      const floor = gen.generate(smallConfig(BiomeType.BASIC_UNDERGROUND), new SeededRandom(42));

      let floors = 0;
      let walls = 0;
      for (let i = 0; i < floor.flags.length; i++) {
        if ((floor.flags[i]! & TileFlags.PASSABLE) !== 0) floors++;
        else walls++;
      }
      expect(floors).toBeGreaterThan(0);
      expect(walls).toBeGreaterThan(0);
    });

    it('should support cave regions with curved tunnels and non-uniform cave rooms', () => {
      const gen = new DungeonGenerator({ roomVariety: true, caveRegions: true });
      const floor = gen.generate(smallConfig(BiomeType.BASIC_UNDERGROUND), new SeededRandom(42));

      let caveFloorCount = 0;
      let caveWallCount = 0;
      let caveJunctionLikeCount = 0;
      for (let y = 1; y < floor.height - 1; y++) {
        for (let x = 1; x < floor.width - 1; x++) {
          const idx = y * floor.width + x;
          if (floor.terrain[idx] === TerrainType.CAVE_FLOOR) {
            caveFloorCount++;
            let caveNeighbors = 0;
            for (const [nx, ny] of [
              [x + 1, y],
              [x - 1, y],
              [x, y + 1],
              [x, y - 1],
            ] as const) {
              const nIdx = ny * floor.width + nx;
              if (floor.terrain[nIdx] === TerrainType.CAVE_FLOOR) caveNeighbors++;
            }
            if (caveNeighbors >= 3) caveJunctionLikeCount++;
          } else if (floor.terrain[idx] === TerrainType.CAVE_WALL) {
            caveWallCount++;
          }
        }
      }

      expect(caveFloorCount).toBeGreaterThan(0);
      expect(caveWallCount).toBeGreaterThan(0);
      expect(caveJunctionLikeCount).toBeGreaterThan(0);
    });

    it('should keep every room reachable from the spawn room across representative seeds', () => {
      const gen = new DungeonGenerator({ roomVariety: true });

      for (const seed of REGRESSION_TEST_SEEDS) {
        const floor = gen.generate(
          smallConfig(BiomeType.BASIC_UNDERGROUND),
          new SeededRandom(seed),
        );
        if (!floor.spawnRoom) continue;

        expect(connectedRoomIds(floor.spawnRoom.id, floor.rooms).size).toBe(floor.rooms.length);
      }
    });

    it('should preserve a passable interior tile next to every room door after reshaping', () => {
      const gen = new DungeonGenerator({ roomVariety: true });

      for (const seed of REGRESSION_TEST_SEEDS) {
        const floor = gen.generate(
          smallConfig(BiomeType.BASIC_UNDERGROUND),
          new SeededRandom(seed),
        );
        for (const room of floor.rooms) {
          for (const door of room.doors) {
            expect(hasReachableInteriorTile(floor, room, door)).toBe(true);
          }
        }
      }
    });

    it('should add paired doors in room-variety maps while flat maps keep single doors', () => {
      const genFlat = new DungeonGenerator({ roomVariety: false });
      const genVariety = new DungeonGenerator({ roomVariety: true });
      const config: MapConfig = {
        widthTiles: 120,
        heightTiles: 70,
        tileSizeFt: 4,
        biome: BiomeType.BASIC_UNDERGROUND,
        seed: 42,
        roomWidthRange: [6, 14],
        roomHeightRange: [5, 13],
        maxRooms: 45,
        floorDensity: 0.42,
      };

      const varietyPairCounts: number[] = [];
      for (const seed of REGRESSION_TEST_SEEDS) {
        const flatFloor = genFlat.generate({ ...config, seed }, new SeededRandom(seed));
        const varietyFloor = genVariety.generate({ ...config, seed }, new SeededRandom(seed));
        expect(countAdjacentDoorPairs(flatFloor)).toBe(0);
        varietyPairCounts.push(countAdjacentDoorPairs(varietyFloor));
      }
      expect(varietyPairCounts.some((count) => count > 0)).toBe(true);
    });

    it('should have no isolated passable floor tiles (all reachable from spawn when doors are open)', () => {
      const gen = new DungeonGenerator({ roomVariety: true });
      // Use the floor1 map size and seed to catch real-world regressions
      const floor1Config: MapConfig = {
        widthTiles: 240,
        heightTiles: 140,
        tileSizeFt: 4,
        biome: BiomeType.BASIC_UNDERGROUND,
        seed: 42,
        roomWidthRange: [10, 22],
        roomHeightRange: [9, 20],
        maxRooms: 70,
        floorDensity: 0.36,
      };

      for (const seed of REGRESSION_TEST_SEEDS) {
        const floor = gen.generate({ ...floor1Config, seed }, new SeededRandom(seed));
        const reachable = reachableTileIndices(floor);

        let isolated = 0;
        for (let idx = 0; idx < floor.width * floor.height; idx++) {
          const flags = floor.tileMap.flags[idx]!;
          const isDoor = (flags & TileFlags.DOOR) !== 0;
          const isPassable = (flags & TileFlags.PASSABLE) !== 0;
          if (isPassable && !isDoor && !reachable.has(idx)) {
            isolated++;
          }
        }
        expect(isolated).toBe(0);
      }
    });

    it('should keep SAFE and BOSS_STAIR room perimeter walls intact after room variety', () => {
      // Locked boss-room doors are treated as pathable for connectivity checks, so
      // sealing the boss room perimeter never creates unreachable areas — the room
      // is always reachable via its designated door tile(s).
      const gen = new DungeonGenerator({ roomVariety: true });
      const config: MapConfig = {
        widthTiles: 120,
        heightTiles: 70,
        tileSizeFt: 4,
        biome: BiomeType.BASIC_UNDERGROUND,
        seed: 42,
        roomWidthRange: [6, 14],
        roomHeightRange: [5, 13],
        maxRooms: 45,
        floorDensity: 0.42,
      };

      for (const seed of REGRESSION_TEST_SEEDS) {
        const floor = gen.generate({ ...config, seed }, new SeededRandom(seed));
        const { width: w } = floor;

        for (const room of floor.rooms) {
          if (room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR) continue;
          const { x, y, width, height } = room.bounds;

          // Build the set of door positions on this room's perimeter for exclusion
          const doorSet = new Set(room.doors.map((d) => `${d.x},${d.y}`));

          // Every perimeter tile must be a wall or a door — never an open corridor
          const perimeterCoords: Array<[number, number]> = [];
          for (let tx = x; tx < x + width; tx++) {
            perimeterCoords.push([tx, y]);
            perimeterCoords.push([tx, y + height - 1]);
          }
          for (let ty = y + 1; ty < y + height - 1; ty++) {
            perimeterCoords.push([x, ty]);
            perimeterCoords.push([x + width - 1, ty]);
          }

          for (const [tx, ty] of perimeterCoords) {
            const tileFlags = floor.tileMap.flags[ty * w + tx]!;
            const isPassable = (tileFlags & TileFlags.PASSABLE) !== 0;
            const isDoor = (tileFlags & TileFlags.DOOR) !== 0;
            const isKnownDoor = doorSet.has(`${tx},${ty}`);
            // Perimeter tiles must be walls or designated doors, never bare floor/corridor
            if (isPassable && !isDoor && !isKnownDoor) {
              throw new Error(
                `seed=${seed} room ${room.id} (${room.role}) has open corridor at perimeter tile (${tx},${ty})`,
              );
            }
          }
        }
      }
    });

    it('should keep SAFE and BOSS_STAIR room interiors fully rectangular after room variety', () => {
      const gen = new DungeonGenerator({ roomVariety: true });
      const config: MapConfig = {
        widthTiles: 120,
        heightTiles: 70,
        tileSizeFt: 4,
        biome: BiomeType.BASIC_UNDERGROUND,
        seed: 42,
        roomWidthRange: [6, 14],
        roomHeightRange: [5, 13],
        maxRooms: 45,
        floorDensity: 0.42,
      };

      for (const seed of REGRESSION_TEST_SEEDS) {
        const floor = gen.generate({ ...config, seed }, new SeededRandom(seed));
        const { width: w } = floor;

        for (const room of floor.rooms) {
          if (room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR) continue;
          const { x, y, width, height } = room.bounds;

          for (let ty = y + 1; ty < y + height - 1; ty += 1) {
            for (let tx = x + 1; tx < x + width - 1; tx += 1) {
              const flags = floor.tileMap.flags[ty * w + tx]!;
              expect(
                (flags & TileFlags.PASSABLE) !== 0,
                `seed=${seed} room ${room.id} (${room.role}) has carved interior wall at (${tx},${ty})`,
              ).toBe(true);
            }
          }
        }
      }
    });

    it('should assign BOSS_STAIR room the same id before and after room variety', () => {
      // Regression: pre-assigning roles must produce the same boss room as the
      // old post-variety distance scoring in normal cases.
      const genVariety = new DungeonGenerator({ roomVariety: true });
      const genFlat = new DungeonGenerator({ roomVariety: false });
      const config: MapConfig = {
        widthTiles: 240,
        heightTiles: 140,
        tileSizeFt: 4,
        biome: BiomeType.BASIC_UNDERGROUND,
        seed: 42,
        roomWidthRange: [10, 22],
        roomHeightRange: [9, 20],
        maxRooms: 70,
        floorDensity: 0.36,
      };

      for (const seed of REGRESSION_TEST_SEEDS) {
        const floorV = genVariety.generate({ ...config, seed }, new SeededRandom(seed));
        const floorF = genFlat.generate({ ...config, seed }, new SeededRandom(seed));

        expect(floorV.bossStairRoom?.id).toBe(floorF.bossStairRoom?.id);
        expect(floorV.safeRoom?.id).toBe(floorF.safeRoom?.id);
      }
    });

    it('should assign BOSS_STAIR and SAFE rooms that meet the minimum size when candidates exist', () => {
      // Use a config where all rooms are at least SPECIAL_ROOM_MIN_WIDTH × SPECIAL_ROOM_MIN_HEIGHT
      // so the minimum-size preference is always exercised.
      const gen = new DungeonGenerator({ roomVariety: true });
      const config: MapConfig = {
        widthTiles: 120,
        heightTiles: 70,
        tileSizeFt: 4,
        biome: BiomeType.BASIC_UNDERGROUND,
        seed: 42,
        roomWidthRange: [SPECIAL_ROOM_MIN_WIDTH, 14],
        roomHeightRange: [SPECIAL_ROOM_MIN_HEIGHT, 13],
        maxRooms: 30,
        floorDensity: 0.42,
      };

      for (const seed of REGRESSION_TEST_SEEDS) {
        const floor = gen.generate({ ...config, seed }, new SeededRandom(seed));

        if (floor.bossStairRoom) {
          expect(floor.bossStairRoom.bounds.width).toBeGreaterThanOrEqual(SPECIAL_ROOM_MIN_WIDTH);
          expect(floor.bossStairRoom.bounds.height).toBeGreaterThanOrEqual(SPECIAL_ROOM_MIN_HEIGHT);
        }
        if (floor.safeRoom) {
          expect(floor.safeRoom.bounds.width).toBeGreaterThanOrEqual(SPECIAL_ROOM_MIN_WIDTH);
          expect(floor.safeRoom.bounds.height).toBeGreaterThanOrEqual(SPECIAL_ROOM_MIN_HEIGHT);
        }
      }
    });

    it('should still assign BOSS_STAIR and SAFE roles when all rooms are smaller than the minimum', () => {
      // When no room meets the minimum size the generator must fall back gracefully
      // and still assign the roles rather than silently skipping them.
      const gen = new DungeonGenerator({
        roomVariety: false,
        specialRoomMinWidth: 999,
        specialRoomMinHeight: 999,
      });
      const config: MapConfig = {
        widthTiles: 120,
        heightTiles: 70,
        tileSizeFt: 4,
        biome: BiomeType.DUNGEON,
        seed: 42,
        roomWidthRange: [4, 8],
        roomHeightRange: [4, 8],
        maxRooms: 20,
        floorDensity: 0.3,
      };

      const floor = gen.generate(config, new SeededRandom(42));

      if (floor.rooms.length >= 2) {
        expect(floor.bossStairRoom).toBeDefined();
        expect(floor.rooms.filter((r) => r.role === RoomRole.BOSS_STAIR)).toHaveLength(1);
      }
      if (floor.rooms.length >= 3) {
        expect(floor.safeRoom).toBeDefined();
        expect(floor.rooms.filter((r) => r.role === RoomRole.SAFE)).toHaveLength(1);
      }
    });

    it('should keep all rooms graph-connected from spawn in cave-region maps across floor1 seeds', () => {
      // Regression: carveCaveRegions converts corridor tiles to CAVE_FLOOR terrain,
      // which used to break the room-adjacency flood-fill (CORRIDOR-only connectors).
      // The fix includes CAVE_FLOOR as a navigable connector so rooms connected
      // through cave-covered corridors are correctly added to the room graph.
      const gen = new DungeonGenerator({ roomVariety: true, caveRegions: true });
      const floor1Config: MapConfig = {
        widthTiles: 240,
        heightTiles: 140,
        tileSizeFt: 4,
        biome: BiomeType.BASIC_UNDERGROUND,
        seed: 42,
        roomWidthRange: [10, 22],
        roomHeightRange: [9, 20],
        maxRooms: 70,
        floorDensity: 0.36,
      };

      // 30 seeds is enough to surface the cave-carving regression, which previously
      // caused graph-disconnection on ~73% of seeds (22/30).
      const TEST_SEEDS = [1, 2, 3, 5, 7, 10, 12, 14, 15, 16, 17, 18, 20, 42, 99] as const;

      for (const seed of TEST_SEEDS) {
        const floor = gen.generate({ ...floor1Config, seed }, new SeededRandom(seed));
        const spawnRoom = floor.spawnRoom;
        if (!spawnRoom) continue;

        const roomsWithPassableInterior = floor.rooms.filter((room) => {
          const { x, y, width, height } = room.bounds;
          for (let ty = y + 1; ty < y + height - 1; ty++) {
            for (let tx = x + 1; tx < x + width - 1; tx++) {
              if (floor.tileMap.isPassable(tx, ty)) return true;
            }
          }
          return false;
        });

        const connected = connectedRoomIds(spawnRoom.id, floor.rooms);
        const disconnectedWithInterior = roomsWithPassableInterior.filter(
          (r) => !connected.has(r.id),
        );

        expect(disconnectedWithInterior).toHaveLength(0);
      }
    });
  });

  describe('CaveGenerator', () => {
    it('should produce a map with correct dimensions', () => {
      const gen = new CaveGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.CAVE), rng);

      expect(floor.width).toBe(60);
      expect(floor.height).toBe(40);
    });

    it('should produce no discrete rooms (cave mode)', () => {
      const gen = new CaveGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.CAVE), rng);

      expect(floor.rooms.length).toBe(0);
    });

    it('should have border walls', () => {
      const gen = new CaveGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.CAVE), rng);

      // Top and bottom rows should be walls
      for (let x = 0; x < 60; x++) {
        expect(floor.tileMap.isPassable(x, 0)).toBe(false);
        expect(floor.tileMap.isPassable(x, 39)).toBe(false);
      }
      // Left and right columns should be walls
      for (let y = 0; y < 40; y++) {
        expect(floor.tileMap.isPassable(0, y)).toBe(false);
        expect(floor.tileMap.isPassable(59, y)).toBe(false);
      }
    });

    it('should have a passable player spawn', () => {
      const gen = new CaveGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.CAVE), rng);

      expect(floor.tileMap.isPassable(floor.playerSpawn.x, floor.playerSpawn.y)).toBe(true);
    });

    it('should produce deterministic output for same seed', () => {
      const gen = new CaveGenerator();
      const config = smallConfig(BiomeType.CAVE);

      const floor1 = gen.generate(config, new SeededRandom(42));
      const floor2 = gen.generate(config, new SeededRandom(42));

      expect(Array.from(floor1.flags)).toEqual(Array.from(floor2.flags));
    });
  });

  describe('ArenaGenerator', () => {
    it('should produce a map with correct dimensions', () => {
      const gen = new ArenaGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.ARENA), rng);

      expect(floor.width).toBe(60);
      expect(floor.height).toBe(40);
    });

    it('should have one room (the arena)', () => {
      const gen = new ArenaGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.ARENA), rng);

      expect(floor.rooms.length).toBe(1);
    });

    it('should have walls around the border', () => {
      const gen = new ArenaGenerator();
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.ARENA), rng);

      expect(floor.tileMap.isPassable(0, 0)).toBe(false);
      expect(floor.tileMap.isPassable(1, 1)).toBe(false); // border thickness=2
      expect(floor.tileMap.isPassable(59, 39)).toBe(false);
    });

    it('should have passable interior', () => {
      const gen = new ArenaGenerator({ obstacleCount: 0 }); // no obstacles
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.ARENA), rng);

      // Center should be passable
      expect(floor.tileMap.isPassable(30, 20)).toBe(true);
    });

    it('should keep spawn area clear of obstacles', () => {
      const gen = new ArenaGenerator({ obstacleCount: 100 }); // lots of obstacles
      const rng = new SeededRandom(42);
      const floor = gen.generate(smallConfig(BiomeType.ARENA), rng);

      // Center spawn should always be passable
      expect(floor.tileMap.isPassable(30, 20)).toBe(true);
    });
  });

  describe('Generator Registry', () => {
    it('should have generators for all BiomeType values', () => {
      const registered = getRegisteredBiomes();
      for (const biome of Object.values(BiomeType)) {
        expect(registered).toContain(biome);
      }
    });

    it('should return correct generator for each biome', () => {
      expect(getGenerator(BiomeType.DUNGEON).name).toBe('DungeonGenerator');
      expect(getGenerator(BiomeType.CAVE).name).toBe('CaveGenerator');
      expect(getGenerator(BiomeType.ARENA).name).toBe('ArenaGenerator');
      expect(getGenerator(BiomeType.BASIC_UNDERGROUND).name).toBe('DungeonGenerator');
    });

    it('should apply cave regions to floor1 basic underground generation', () => {
      const config: MapConfig = {
        widthTiles: 240,
        heightTiles: 140,
        tileSizeFt: 4,
        biome: BiomeType.BASIC_UNDERGROUND,
        seed: 42,
        roomWidthRange: [10, 22],
        roomHeightRange: [9, 20],
        maxRooms: 70,
        floorDensity: 0.36,
      };

      const floor = getGenerator(BiomeType.BASIC_UNDERGROUND).generate(
        config,
        new SeededRandom(42),
      );
      const caveFloors = floor.terrain.reduce(
        (count, t) => (t === TerrainType.CAVE_FLOOR ? count + 1 : count),
        0,
      );
      expect(caveFloors).toBeGreaterThan(0);
    });

    it('should throw for unknown biome', () => {
      expect(() => getGenerator('nonexistent' as BiomeType)).toThrow();
    });
  });
});
