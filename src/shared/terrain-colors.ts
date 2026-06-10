/**
 * Fallback colours for TerrainTypes that have no sprite mapping.
 *
 * This is the single source of truth for terrain fallback colours. Both the
 * engine renderer (terrain-renderer.ts) and the tile-render-lab consume this
 * table so the two can never drift out of sync.
 */

import { TerrainType } from './map-types.js';

/** Fallback solid colours (0xRRGGBB) when a TerrainType has no sprite mapping. */
export const TERRAIN_FALLBACK_COLORS: Readonly<Record<number, number>> = {
  [TerrainType.VOID]: 0x05060f,
  [TerrainType.STONE_FLOOR]: 0x1f2937,
  [TerrainType.STONE_WALL]: 0x111827,
  [TerrainType.DOOR]: 0x8b5e34,
  [TerrainType.CORRIDOR]: 0x233044,
  [TerrainType.WATER]: 0x1d4ed8,
  [TerrainType.LAVA]: 0xb91c1c,
  [TerrainType.GRASS]: 0x166534,
  [TerrainType.DIRT]: 0x6b3f24,
  [TerrainType.WOOD_FLOOR]: 0x5b4430,
  [TerrainType.WOOD_WALL]: 0x3a2d20,
  [TerrainType.CAVE_FLOOR]: 0x2a2a3d,
  [TerrainType.CAVE_WALL]: 0x1b1b29,
  [TerrainType.TREE]: 0x14532d,
  [TerrainType.RUBBLE]: 0x334155,
};

/** Convert a numeric 0xRRGGBB colour to a CSS hex string (e.g. `'#1f2937'`). */
export function colorToCss(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}
