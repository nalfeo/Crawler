/**
 * Tile visual definitions — map TerrainType values to Kenney spritesheet frames.
 *
 * This is the authoritative table that translates procedural map data (TerrainType
 * enum, stored in FloorMap.terrain) into renderable sprites. The terrain-renderer
 * consults this table when building the world tilemap; any TerrainType without an
 * entry falls back to the solid-color rendering path.
 *
 * Frame indices reference the Kenney Tiny Dungeon sheet (key: 'kenney-tiny-dungeon',
 * 12 cols × 11 rows, 16×16 px tiles, 1 px gap). Use the tile-explorer-lab
 * (?lab=tile-explorer) to browse frames visually and verify/update mappings here.
 *
 * Frame index formula: row * 12 + col
 *
 * Layout quick-reference (verify in tile-explorer-lab):
 *   Row 0  (frames  0-11):  Stone wall / carved block tiles
 *   Row 1  (frames 12-23):  Stone floor tiles (basic walkable)
 *   Row 2  (frames 24-35):  Stone floor variants (darker, worn)
 *   Row 3  (frames 36-47):  Props — stairs, chests, barrels, bones
 *   Rows 4+ :               Sprite characters, items, weapons
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
export declare function neighborMask(
  terrain: Uint8Array,
  mapWidth: number,
  mapHeight: number,
  tx: number,
  ty: number,
  matchTerrain: TerrainType,
): number;
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
export declare function resolveFrame(
  visual: TileVisualDef,
  terrain: Uint8Array,
  mapWidth: number,
  mapHeight: number,
  tx: number,
  ty: number,
  terrainAt: TerrainType,
): number;
/**
 * Tile visual map — sparse by design.
 *
 * Only TerrainTypes that have confirmed spritesheet coverage are listed here.
 * Add entries as sprites are visually verified in the tile-explorer-lab.
 *
 * NOTE: These frame indices are initial best-guess values derived from the
 * typical Kenney Tiny Dungeon sheet layout. Open the tile-explorer-lab
 * (?lab=tile-explorer) and select 'kenney-tiny-dungeon' to confirm each
 * frame before shipping a floor that relies on these.
 *
 * Blob-tile `frames` arrays
 * -------------------------
 * Each 16-entry array is indexed by the 4-dir neighbor mask (N=bit0, E=bit1,
 * S=bit2, W=bit3).  All entries currently default to the base `frame` value
 * and must be tuned in ?lab=tile-render-lab once the sheet layout is confirmed
 * in ?lab=tile-explorer.  Replace each entry with the correct frame index for
 * that connectivity pattern and the renderer will pick it up automatically.
 */
export declare const TILE_SPRITES: Readonly<Partial<Record<TerrainType, TileVisualDef>>>;
/**
 * Look up the tile visual definition for a given TerrainType.
 * Returns undefined for TerrainTypes not yet mapped to a sprite
 * (callers should fall back to solid-color rendering in that case).
 */
export declare function getTileVisual(terrain: TerrainType): TileVisualDef | undefined;
//# sourceMappingURL=tile-visuals.d.ts.map
