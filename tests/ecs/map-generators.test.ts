import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../../src/shared/random';
import { BiomeType, TileFlags, RoomRole } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import { DungeonGenerator } from '../../src/core/map/generators/DungeonGenerator';
import { CaveGenerator } from '../../src/core/map/generators/CaveGenerator';
import { ArenaGenerator } from '../../src/core/map/generators/ArenaGenerator';
import { getGenerator, getRegisteredBiomes } from '../../src/core/map/generators/registry';

/** Small map config for fast test generation. */
function smallConfig(biome: BiomeType): MapConfig {
  return {
    widthTiles: 60,
    heightTiles: 40,
    tileSizePx: 32,
    biome,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 10,
    floorDensity: 0.3,
  };
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

    it('should not produce fewer floor tiles than standard DungeonGenerator', () => {
      // Room variety can only add tiles (carving + widening), never remove all floor tiles.
      const baseGen = new DungeonGenerator();
      const varGen = new DungeonGenerator({ roomVariety: true });
      const config = smallConfig(BiomeType.DUNGEON);

      const baseFloor = baseGen.generate(config, new SeededRandom(7));
      // Generate with variety using the same seed
      const varFloor = varGen.generate(
        { ...config, biome: BiomeType.BASIC_UNDERGROUND },
        new SeededRandom(7),
      );

      const countPassable = (flags: Uint8Array): number =>
        Array.from(flags).filter((f) => (f & TileFlags.PASSABLE) !== 0).length;

      // Variety map should have at least as many passable tiles (corridors widened, diagonals added)
      expect(countPassable(varFloor.flags)).toBeGreaterThanOrEqual(countPassable(baseFloor.flags));
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

    it('should throw for unknown biome', () => {
      expect(() => getGenerator('nonexistent' as BiomeType)).toThrow();
    });
  });
});
