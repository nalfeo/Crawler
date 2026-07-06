/**
 * Map type definitions — tile flags, biome types, and data structures
 * for procedural floor generation.
 *
 * These are pure data types with no rendering or ECS dependencies.
 */

// --- Tile Flag Bitfield ---

/** Bitflags for tile properties. Stored per-tile in a Uint8Array. */
export const TileFlags = {
  PASSABLE: 0b0001,
  TRANSPARENT: 0b0010,
  DOOR: 0b0100,
  LIQUID: 0b1000,
} as const;

/** Pre-composed tile flag combos for common tile types. */
export const TilePresets = {
  WALL: 0,
  FLOOR: TileFlags.PASSABLE | TileFlags.TRANSPARENT,
  DOOR_CLOSED: TileFlags.DOOR,
  DOOR_OPEN: TileFlags.PASSABLE | TileFlags.TRANSPARENT | TileFlags.DOOR,
  WINDOW: TileFlags.TRANSPARENT,
  SHALLOW_WATER: TileFlags.PASSABLE | TileFlags.TRANSPARENT | TileFlags.LIQUID,
} as const;

// --- Terrain Visual Types ---

/** Visual terrain types for rendering. Separate from physics flags. */
export enum TerrainType {
  VOID = 0,
  STONE_FLOOR = 1,
  STONE_WALL = 2,
  DOOR = 3,
  CORRIDOR = 4,
  WATER = 5,
  LAVA = 6,
  GRASS = 7,
  DIRT = 8,
  WOOD_FLOOR = 9,
  WOOD_WALL = 10,
  CAVE_FLOOR = 11,
  CAVE_WALL = 12,
  TREE = 13,
  RUBBLE = 14,
  /** Floor tiles inside a boss/staircase room — rendered distinctly for player readability. */
  BOSS_STAIR_FLOOR = 15,
  /** Floor tiles inside a safe room — rendered with a calm blue tint. */
  SAFE_ROOM_FLOOR = 16,
}

// --- Biome Types ---

export enum BiomeType {
  DUNGEON = 'dungeon',
  CAVE = 'cave',
  ARENA = 'arena',
  CASTLE = 'castle',
  FOREST = 'forest',
  FIRE_SWAMP = 'fire_swamp',
  TOWN = 'town',
  OPEN_WORLD = 'open_world',
  /** Starter floor — structured rooms with high variety (round, L-shaped, wide corridors). */
  BASIC_UNDERGROUND = 'basic_underground',
  /** Floor 2 — open cavern network with family territories, boss dens, settlement, resource heart. */
  CAVE_SYSTEM = 'cave_system',
}

// --- Map Configuration ---

export interface MapConfig {
  /** Width in tiles. Independent of height — maps can be rectangular. */
  readonly widthTiles: number;
  /** Height in tiles. Independent of width — maps can be rectangular. */
  readonly heightTiles: number;
  /** Tile size in feet. Default: 4. */
  readonly tileSizeFt: number;
  /** Biome determines generator algorithm + visual theme. */
  readonly biome: BiomeType;
  /** Seed for deterministic generation. */
  readonly seed: number;
  /** Minimum room width in tiles (for room-based generators). */
  readonly roomWidthRange: readonly [min: number, max: number];
  /** Minimum room height in tiles (for room-based generators). */
  readonly roomHeightRange: readonly [min: number, max: number];
  /** Maximum number of rooms to generate. */
  readonly maxRooms: number;
  /** Target percentage of floor tiles (for cellular automata generators). */
  readonly floorDensity: number;
  /** Optional biome-specific cave-system knobs (Floor 2). */
  readonly caveSystem?: {
    /** Number of family territories to stamp (3–4). */
    readonly presentCount?: number;
    /** Cellular initial fill ratio (higher = more open caverns). */
    readonly initialFill?: number;
    /** Cellular smoothing passes. */
    readonly smoothingPasses?: number;
    /** Boss-den side length in tiles. */
    readonly bossDenSize?: number;
    /** Minimum tile separation between region seeds. */
    readonly regionSeparationTiles?: number;
    /** Maximum retry attempts before generation fails. */
    readonly maxRetries?: number;
    /** Number of post-connect cavern widening passes. */
    readonly cavernWidenPasses?: number;
    /** Minimum run length to perturb straight hallway segments. */
    readonly straightHallwayMinRun?: number;
  };
}

/** Sensible defaults — 2 min × 2 min traversal at base player speed. */
export const DEFAULT_MAP_CONFIG: MapConfig = {
  widthTiles: 675,
  heightTiles: 675,
  tileSizeFt: 4,
  biome: BiomeType.DUNGEON,
  seed: 42,
  roomWidthRange: [5, 15],
  roomHeightRange: [5, 15],
  maxRooms: 30,
  floorDensity: 0.45,
};

// --- Room Roles ---

/** Semantic role assigned to each room during map generation. */
export enum RoomRole {
  /** Player spawns here at floor start. */
  SPAWN = 'spawn',
  /** Boss spawns here; stairs to the next floor appear after the boss is defeated. */
  BOSS_STAIR = 'boss_stair',
  /** Safe room — healing, merchant, objective marker. */
  SAFE = 'safe',
  /** Standard combat/loot room. */
  NORMAL = 'normal',
  /** Floor 2 — a family faction's home cavern. Carries `familyIndex`. */
  TERRITORY = 'territory',
  /** Floor 2 — sealed sub-chamber holding a family's boss. Carries `familyIndex`. */
  BOSS_DEN = 'boss_den',
  /** Floor 2 — neutral safe cavern (traders, quest-givers). */
  SETTLEMENT = 'settlement',
  /** Floor 2 — central objective cavern; Slice 5 spawns floor-exit stairs at its centre. */
  RESOURCE_HEART = 'resource_heart',
}

// --- Room Data ---

export interface RoomBounds {
  /** Top-left tile X. */
  readonly x: number;
  /** Top-left tile Y. */
  readonly y: number;
  /** Width in tiles. */
  readonly width: number;
  /** Height in tiles. */
  readonly height: number;
}

export interface DoorLocation {
  /** Tile X of the door. */
  readonly x: number;
  /** Tile Y of the door. */
  readonly y: number;
  /** Index of the connected room (in the room list). */
  readonly connectsTo: number;
}

export interface RoomData {
  /** Unique room index within this floor. */
  readonly id: number;
  /** Bounding rectangle in tile coordinates. */
  readonly bounds: RoomBounds;
  /** Door positions on this room's walls. */
  readonly doors: readonly DoorLocation[];
  /** Indices of rooms connected via doors/corridors. */
  readonly neighbors: readonly number[];
  /** Semantic role assigned during generation. */
  role: RoomRole;
  /** Optional label for AI/narrative use. */
  readonly label?: string;
  /** Floor 2 — index into the present-families roster (0..presentCount-1) for TERRITORY / BOSS_DEN rooms. Slice 8 binds this to a real family id. */
  readonly familyIndex?: number;
  /**
   * Explicit interior tile mask. Populated by irregular-shape generators (e.g. CaveSystemGenerator)
   * where the axis-aligned {@link bounds} would falsely claim wall tiles as interior. When present,
   * RoomGraph uses these tiles for `getRoomAt` / `getRandomInteriorTile`; when absent, generators
   * fall back to the classic 1-tile-inset-of-bounds behaviour used by rectangular room generators.
   */
  readonly interiorCells?: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

// --- Floor Map (composite output of generation) ---

export interface FloorMapData {
  /** Map configuration used to generate this floor. */
  readonly config: MapConfig;
  /** Tile physics flags — flat array [y * width + x]. */
  readonly flags: Uint8Array;
  /** Tile visual terrain types — flat array [y * width + x]. */
  readonly terrain: Uint8Array;
  /** Room definitions. Empty for biomes without discrete rooms (e.g., caves). */
  readonly rooms: readonly RoomData[];
  /** FOV visibility bitmap — updated per frame by the FOV system. */
  readonly visible: Uint8Array;
  /** Player spawn tile position. */
  readonly playerSpawn: { readonly x: number; readonly y: number };
}
