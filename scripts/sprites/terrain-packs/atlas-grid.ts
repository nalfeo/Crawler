/**
 * Shared atlas-grid layout for terrain-pack wall autotile sheets.
 *
 * Both packs (authored "industrial-cave" and vendored "caeles-fixture") use
 * the SAME grid shape and the SAME canonical-mask → frameIndex assignment, so
 * the two build scripts and the runtime frame lookup never disagree about
 * where a given mask lives in the sheet.
 *
 * Frame assignment: the 47 canonical blob47 masks (see
 * `BLOB47_CANONICAL_MASKS`, already in a fixed ascending order) are assigned
 * frame indices 0..46 in that same ascending order. Index 47 (the 48th grid
 * cell) is left as an explicit spare/unused cell — the grid is 8x6 = 48 cells
 * because 47 doesn't factor into a clean rectangle, and the TESTS section of
 * the spec pins the output atlas at 512x384 (8x6 x 64px).
 */
import { BLOB47_CANONICAL_MASKS } from '../../../src/shared/terrain-pack-mask.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';

export const ATLAS_GRID_COLS = 8;
export const ATLAS_GRID_ROWS = 6;
export const ATLAS_GRID_CELLS = ATLAS_GRID_COLS * ATLAS_GRID_ROWS; // 48
export const ATLAS_WIDTH_PX = ATLAS_GRID_COLS * TERRAIN_PACK_CELL_PX; // 512
export const ATLAS_HEIGHT_PX = ATLAS_GRID_ROWS * TERRAIN_PACK_CELL_PX; // 384

/** One explicit mask→frame assignment row, in canonical ascending-mask order. */
export interface MaskFrameAssignment {
  readonly maskId: number;
  readonly frameIndex: number;
}

/**
 * The canonical, explicit mask→frameIndex assignment table (length 47, frame
 * indices 0..46). Computed once from `BLOB47_CANONICAL_MASKS`'s fixed
 * ordering — deterministic and reused by both build scripts.
 */
export function buildMaskFrameAssignments(): readonly MaskFrameAssignment[] {
  return BLOB47_CANONICAL_MASKS.map((maskId, frameIndex) => ({ maskId, frameIndex }));
}

/** Pixel origin (top-left) of `frameIndex` within the atlas grid. */
export function frameOriginPx(frameIndex: number): { x: number; y: number } {
  const col = frameIndex % ATLAS_GRID_COLS;
  const row = Math.floor(frameIndex / ATLAS_GRID_COLS);
  return { x: col * TERRAIN_PACK_CELL_PX, y: row * TERRAIN_PACK_CELL_PX };
}
