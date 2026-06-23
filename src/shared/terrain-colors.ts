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
  [TerrainType.STONE_FLOOR]: 0x2d3a4a, // mid blue-gray — room interiors
  [TerrainType.STONE_WALL]: 0x0d1117, // near-black — solid wall mass
  [TerrainType.DOOR]: 0x8b5e34,
  [TerrainType.CORRIDOR]: 0x1e2d3d, // slightly darker than floor — tunnels
  [TerrainType.WATER]: 0x1d4ed8,
  [TerrainType.LAVA]: 0xb91c1c,
  [TerrainType.GRASS]: 0x166534,
  [TerrainType.DIRT]: 0x6b3f24,
  [TerrainType.WOOD_FLOOR]: 0x5b4430,
  [TerrainType.WOOD_WALL]: 0x1a1108,
  [TerrainType.CAVE_FLOOR]: 0x6b4a2e, // warm earthen tan — open cavern floor
  [TerrainType.CAVE_WALL]: 0x2c1a16, // dark earthen rock — solid cave wall mass
  [TerrainType.TREE]: 0x14532d,
  [TerrainType.RUBBLE]: 0x3d3d3d,
  [TerrainType.BOSS_STAIR_FLOOR]: 0x3d0a18, // deep red — boss room
  [TerrainType.SAFE_ROOM_FLOOR]: 0x0a2040, // deep blue — safe room
};

/** Convert a numeric 0xRRGGBB colour to a CSS hex string (e.g. `'#1f2937'`). */
export function colorToCss(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}
