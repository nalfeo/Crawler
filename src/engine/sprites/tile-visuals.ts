/**
 * Tile visual definitions — map TerrainType values to Kenney spritesheet frames.
 *
 * This is the authoritative table that translates procedural map data (TerrainType
 * enum, stored in FloorMap.terrain) into renderable sprites. The terrain-renderer
 * consults this table when building the world tilemap; any TerrainType without an
 * entry falls back to the solid-color rendering path.
 *
 * Sheets used:
 *   kenney-tiny-dungeon   12 cols × 11 rows, 16×16 px, 1 px gap (132 tiles)
 *   kenney-tiny-town      12 cols × 11 rows, 16×16 px, 1 px gap (132 tiles)
 *   kenney-roguelike-rpg-pack  57 cols × 31 rows, 16×16 px, 1 px gap (1767 tiles)
 *
 * Frame index formula: row * numCols + col
 *
 * Use the tile-explorer-lab (?lab=tile-explorer) to browse frames visually and
 * verify/update mappings here.
 *
 * kenney-tiny-dungeon layout quick-reference (verified via colour analysis):
 *   Rows 0–2  (frames  0–35): Warm pink/brown wall blocks + cool blue-gray accents
 *   Row  3    (frames 36–47): Blue-gray stone blocks (f36–f40) + warm props (f41–f47)
 *   Row  4    (frames 48–59): Floor tiles — warm tan (f48–f53) + cool blue-gray (f54–f59)
 *   Rows 5–7  (frames 60–95): Items, weapons, UI elements
 *   Rows 8–10 (frames 96–131): Characters (player, enemies, NPCs)
 *
 * kenney-tiny-town layout quick-reference (verified via colour analysis):
 *   Row  0    (frames  0–11): Grass/earth tiles — bright grass (f0–f2), warm brown dirt (f3), more grass (f4–f8), brown dirt/road (f9–f11)
 *   Rows 1–3  (frames 12–47): More grass variants, path/tan floors, tree tops
 *   Row  4    (frames 48–59): Blue-gray tiles (water/stone)
 *   Rows 6+   (frames 72+):   Buildings, walls, characters
 *
 * kenney-roguelike-rpg-pack layout quick-reference (verified via colour analysis):
 *   Row  0    (frames  0–56): Bright cyan water (f0–f4), grass (f5), warm terrain (f6+)
 *                              Hot orange lava/fire tiles at col 49–54
 *
 * All mappings in this file are PLACEHOLDER quality — best available from the
 * current CC0 Kenney sheets. Custom-generated tile sprites will replace them.
 * Terrain types with no suitable sheet tile are left unmapped and fall back to the
 * solid-color rendering path defined in src/shared/terrain-colors.ts.
 *
 * Blob-tile autotiling (4-directional)
 * ------------------------------------
 * When a `TileVisualDef` includes a `frames` array (16 entries), the terrain
 * renderer selects the frame by computing a 4-bit neighbor mask via
 * `neighborMask()`. The mask bits are:
 *
 *   Bit 0 (value  1): North neighbour is the same terrain type
 *   Bit 1 (value  2): East  neighbour is the same terrain type
 *   Bit 2 (value  4): South neighbour is the same terrain type
 *   Bit 3 (value  8): West  neighbour is the same terrain type
 *
 * So `frames[mask]` selects the correct tile variant (0 = isolated, 15 = fully
 * surrounded). Out-of-bounds neighbours are treated as non-matching. When
 * `frames` is absent the single `frame` field is used, preserving all existing
 * behaviour.
 *
 * No imports from src/core/, src/game/, or src/labs/.
 */

import { TerrainType } from '../../shared/map-types.js';

/**
 * A 16-entry frame array for 4-directional blob-tile autotiling.
 * Indexed by the 4-bit neighbour mask from `neighborMask()`:
 * entry 0 = isolated, entry 15 = fully surrounded.
 */
export type BlobFrames16 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Maps a TerrainType to the sheet and frame to stamp at that tile position. */
export interface TileVisualDef {
  /** Phaser texture key — must be a key registered in SHEETS. */
  readonly sheetKey: string;
  /**
   * Frame index used when `frames` is absent, or as a safe fallback if the
   * mask index is somehow out of range.
   */
  readonly frame: number;
  /**
   * Optional 16-entry blob-tile frame array for 4-directional autotiling.
   *
   * Index into this array with the value returned by `neighborMask()`. Each
   * entry is a frame index in the same sheet as `sheetKey`. When this field
   * is present, `buildTerrainLayer` (and the tile-render-lab) will call
   * `neighborMask` for every tile and use `frames[mask]` instead of `frame`.
   *
   * Bit encoding: N=bit0, E=bit1, S=bit2, W=bit3 (see module doc above).
   * Entry 0  = isolated (no same-terrain neighbours)
   * Entry 15 = fully surrounded (all four cardinal neighbours match)
   *
   * Use ?lab=tile-explorer to find the frame indices for each combination,
   * then populate/verify the array before shipping a floor that relies on it.
   */
  readonly frames?: BlobFrames16;
}

/**
 * Compute a 4-bit neighbour mask for blob-tile autotiling.
 *
 * Checks the four cardinal neighbours of tile (tx, ty) in the terrain flat
 * array, setting a bit for each neighbour whose terrain equals `matchTerrain`.
 *
 *   Bit 0 (1): North  (ty - 1)
 *   Bit 1 (2): East   (tx + 1)
 *   Bit 2 (4): South  (ty + 1)
 *   Bit 3 (8): West   (tx - 1)
 *
 * Out-of-bounds neighbours are treated as non-matching (bit = 0).
 *
 * @param terrain      Flat terrain array, row-major: terrain[ty * mapWidth + tx].
 * @param mapWidth     Number of tile columns.
 * @param mapHeight    Number of tile rows.
 * @param tx           X tile coordinate of the tile to evaluate.
 * @param ty           Y tile coordinate of the tile to evaluate.
 * @param matchTerrain The terrain type to match against neighbours.
 * @returns            Integer 0–15 suitable for indexing into `TileVisualDef.frames`.
 */
export function neighborMask(
  terrain: Uint8Array,
  mapWidth: number,
  mapHeight: number,
  tx: number,
  ty: number,
  matchTerrain: TerrainType,
): number {
  let mask = 0;
  if (ty > 0 && terrain[(ty - 1) * mapWidth + tx] === matchTerrain) mask |= 1; // N
  if (tx < mapWidth - 1 && terrain[ty * mapWidth + (tx + 1)] === matchTerrain) mask |= 2; // E
  if (ty < mapHeight - 1 && terrain[(ty + 1) * mapWidth + tx] === matchTerrain) mask |= 4; // S
  if (tx > 0 && terrain[ty * mapWidth + (tx - 1)] === matchTerrain) mask |= 8; // W
  return mask;
}

/**
 * Resolve the frame index for a tile, applying blob-tile autotiling when the
 * visual definition carries a `frames` array.
 *
 * When `visual.frames` is present, the 4-bit neighbour mask is computed via
 * `neighborMask` and used to index into the array. Falls back to `visual.frame`
 * when `frames` is absent or if the mask is somehow out of range.
 *
 * @param visual     Tile visual definition (from `TILE_SPRITES`).
 * @param terrain    Flat terrain array for the floor map.
 * @param mapWidth   Map width in tiles.
 * @param mapHeight  Map height in tiles.
 * @param tx         Tile X coordinate.
 * @param ty         Tile Y coordinate.
 * @param terrainAt  Terrain type at (tx, ty) — used as the match type for the mask.
 * @returns          Frame index to stamp from `visual.sheetKey`.
 */
export function resolveFrame(
  visual: TileVisualDef,
  terrain: Uint8Array,
  mapWidth: number,
  mapHeight: number,
  tx: number,
  ty: number,
  terrainAt: TerrainType,
): number {
  if (visual.frames === undefined) return visual.frame;
  const mask = neighborMask(terrain, mapWidth, mapHeight, tx, ty, terrainAt);
  return visual.frames[mask] ?? visual.frame;
}

const TD = 'kenney-tiny-dungeon';
const TT = 'kenney-tiny-town';
const RPG = 'kenney-roguelike-rpg-pack';

/** col/row → frame index for kenney-tiny-dungeon and kenney-tiny-town (both 12 columns). */
function td(col: number, row: number): number {
  return row * 12 + col;
}

/** col/row → frame index for kenney-tiny-town (12 columns, same formula as td). */
function tt(col: number, row: number): number {
  return row * 12 + col;
}

/** col/row → frame index for kenney-roguelike-rpg-pack (57 columns). */
function rpg(col: number, row: number): number {
  return row * 57 + col;
}

/**
 * Tile visual map — placeholder quality, using best available CC0 Kenney frames.
 *
 * All entries here are interim placeholders; custom-generated sprites will
 * replace them. Terrain types with no suitable sheet tile remain unmapped and
 * fall back to the solid-color rendering path (terrain-colors.ts):
 *   - VOID   → near-black solid (0x05060f)
 *   - LAVA   → deep red solid   (0xb91c1c)
 *
 * Blob-tile `frames` arrays
 * -------------------------
 * Each 16-entry array is indexed by the 4-dir neighbor mask (N=bit0, E=bit1,
 * S=bit2, W=bit3). The Tiny Dungeon sheet has no directional wall corner
 * variants, so every mask entry uses the same frame — this keeps wall areas
 * cohesive rather than mixing in unrelated tiles. Tune these in
 * ?lab=tile-render-lab once purpose-built autotile sheets are available.
 */
export const TILE_SPRITES: Readonly<Partial<Record<TerrainType, TileVisualDef>>> = {
  // ── Stone dungeon biome ────────────────────────────────────────────────────

  /**
   * Stone floor — warm sandy tan (row 4, col 0; ~rgb 234,165,108).
   * Classic cut-stone dungeon room floor.
   */
  [TerrainType.STONE_FLOOR]: { sheetKey: TD, frame: td(0, 4) },

  /**
   * Stone wall block — mid blue-gray (row 3, col 4; ~rgb 123,138,163) with
   * 4-dir autotiling. Reads as dressed stone blocks.
   */
  [TerrainType.STONE_WALL]: {
    sheetKey: TD,
    frame: td(4, 3),
    frames: [
      td(4, 3), //  0: isolated          (no neighbours)
      td(4, 3), //  1: N
      td(4, 3), //  2: E
      td(4, 3), //  3: N+E
      td(4, 3), //  4: S
      td(4, 3), //  5: N+S  (vertical run)
      td(4, 3), //  6: E+S
      td(4, 3), //  7: N+E+S
      td(4, 3), //  8: W
      td(4, 3), //  9: N+W
      td(4, 3), // 10: E+W  (horizontal run)
      td(4, 3), // 11: N+E+W
      td(4, 3), // 12: S+W
      td(4, 3), // 13: N+S+W
      td(4, 3), // 14: E+S+W
      td(4, 3), // 15: N+E+S+W (fully surrounded)
    ],
  },

  /**
   * Corridor floor — cool blue-gray (row 4, col 9; ~rgb 120,129,152).
   * Visually cooler and darker than the warm stone room floor, distinguishing
   * cut-stone passages from open rooms at a glance.
   */
  [TerrainType.CORRIDOR]: { sheetKey: TD, frame: td(9, 4) },

  /**
   * Door tile — base floor sprite so the passable path reads as walkable;
   * the door overlay system draws the actual door glyph on top.
   */
  [TerrainType.DOOR]: { sheetKey: TD, frame: td(0, 4) },

  // ── Cave biome ─────────────────────────────────────────────────────────────

  /**
   * Cave floor — warm earthen tan with scattered pebbles (row 4, col 5;
   * frame 53). A continuous, open ground surface (no centred furniture motif)
   * that reads clearly as walkable cavern floor, in strong value contrast to
   * the solid CAVE_WALL rock so passages no longer blend into the walls.
   */
  [TerrainType.CAVE_FLOOR]: { sheetKey: TD, frame: td(5, 4) },

  /**
   * Cave wall — solid dark earthen rock block (row 0, col 0; frame 0) with
   * 4-dir autotiling. A fully-filled tile with no interior motif, so it reads
   * unambiguously as an impassable rock mass rather than a prop; its warm
   * brown also distinguishes organic caves from the gray cut-stone dungeon
   * walls.
   */
  [TerrainType.CAVE_WALL]: {
    sheetKey: TD,
    frame: td(0, 0),
    frames: [
      td(0, 0), //  0: isolated
      td(0, 0), //  1: N
      td(0, 0), //  2: E
      td(0, 0), //  3: N+E
      td(0, 0), //  4: S
      td(0, 0), //  5: N+S
      td(0, 0), //  6: E+S
      td(0, 0), //  7: N+E+S
      td(0, 0), //  8: W
      td(0, 0), //  9: N+W
      td(0, 0), // 10: E+W
      td(0, 0), // 11: N+E+W
      td(0, 0), // 12: S+W
      td(0, 0), // 13: N+S+W
      td(0, 0), // 14: E+S+W
      td(0, 0), // 15: N+E+S+W
    ],
  },

  // ── Surface-world imported biome ───────────────────────────────────────────

  /**
   * Wood floor — warm brown plank (tiny-town row 3, col 8; ~rgb 136,88,71).
   * Used for surface-world rooms transported into the dungeon.
   */
  [TerrainType.WOOD_FLOOR]: { sheetKey: TT, frame: tt(8, 3) },

  /**
   * Wood wall — warm red-brown facade (tiny-town row 6, col 1; ~rgb 192,114,78).
   * Replaces the previous blue-gray stone stand-in.
   */
  [TerrainType.WOOD_WALL]: { sheetKey: TT, frame: tt(1, 6) },

  // ── Outdoor / natural terrain ──────────────────────────────────────────────

  /**
   * Grass — bright green (tiny-town row 0, col 0; ~rgb 132,198,105).
   * Used for outdoor-feel surface rooms and naturalist floors.
   */
  [TerrainType.GRASS]: { sheetKey: TT, frame: tt(0, 0) },

  /**
   * Dirt — warm brown (tiny-town row 0, col 3; ~rgb 158,112,63).
   * Paths, earthen floors, and exposed ground.
   */
  [TerrainType.DIRT]: { sheetKey: TT, frame: tt(3, 0) },

  /**
   * Tree — green canopy top (tiny-town row 3, col 7; ~rgb 143,195,130).
   * Impassable solid; renders the tree-top silhouette.
   */
  [TerrainType.TREE]: { sheetKey: TT, frame: tt(7, 3) },

  /**
   * Water — bright cyan (RPG pack row 0, col 0; ~rgb 99,197,207).
   * Shallow-water passable tiles; the brighter hue reads clearly against the
   * muted dungeon palette.
   */
  [TerrainType.WATER]: { sheetKey: RPG, frame: rpg(0, 0) },

  /**
   * Lava — hot orange (RPG pack row 0, col 49; ~rgb 187,95,37).
   * Impassable; the saturated orange contrasts sharply with stone and cave.
   */
  [TerrainType.LAVA]: { sheetKey: RPG, frame: rpg(49, 0) },

  // ── Special room floors ────────────────────────────────────────────────────

  /**
   * Rubble / debris tile (row 2, col 2; ~rgb 130,106,113).
   */
  [TerrainType.RUBBLE]: { sheetKey: TD, frame: td(2, 2) },

  /**
   * Boss / staircase room floor — slightly darker warm tan (row 4, col 4;
   * ~rgb 219,146,95). A subtle step darker than the standard stone floor so
   * the boss room reads as distinct without jarring contrast.
   */
  [TerrainType.BOSS_STAIR_FLOOR]: { sheetKey: TD, frame: td(4, 4) },

  /**
   * Safe room floor — cool medium blue (row 4, col 10; ~rgb 115,119,140).
   * The cooler blue tone reinforces the "backstage commercial break" calm
   * intended for safe rooms.
   */
  [TerrainType.SAFE_ROOM_FLOOR]: { sheetKey: TD, frame: td(10, 4) },
} as const;

/**
 * Look up the tile visual definition for a given TerrainType.
 * Returns undefined for TerrainTypes not yet mapped to a sprite
 * (callers should fall back to solid-color rendering in that case).
 */
export function getTileVisual(terrain: TerrainType): TileVisualDef | undefined {
  return TILE_SPRITES[terrain];
}
