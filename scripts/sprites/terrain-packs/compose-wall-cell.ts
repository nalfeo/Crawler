/**
 * Compose one 256x256 wall-cell image from the quadrant kit for a given
 * canonical blob47 mask, then produce the deterministic 64x64 output cell
 * (reviewed-design refinement #4: explicit source size + nearest-neighbor
 * downsample, never implicit resizing).
 */
import {
  quadrantStateFromMask,
  QUADRANT_CORNERS,
  type QuadrantCorner,
} from '../../../src/shared/terrain-pack-mask.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import { compositeInto, createImage, nearestNeighborResize, type RgbaImage } from './png-buffer.js';
import { QUADRANT_SRC_PX, quadrantKitKey } from './quadrant-kit.js';

/** Explicit composed-cell source size before downsampling — pinned, not inferred. */
const WALL_CELL_SRC_PX = QUADRANT_SRC_PX * 2; // 256

/** Where each corner's quadrant is pasted within the composed 256x256 cell. */
const QUADRANT_ORIGIN: Record<QuadrantCorner, { x: number; y: number }> = {
  NW: { x: 0, y: 0 },
  NE: { x: QUADRANT_SRC_PX, y: 0 },
  SE: { x: QUADRANT_SRC_PX, y: QUADRANT_SRC_PX },
  SW: { x: 0, y: QUADRANT_SRC_PX },
};

/**
 * Compose the full-resolution (256x256) wall cell for `canonicalMask` from a
 * pre-generated quadrant kit (see `generateQuadrantKit`).
 */
function composeWallCellSrc(
  canonicalMask: number,
  quadrantKit: ReadonlyMap<string, RgbaImage>,
): RgbaImage {
  const cell = createImage(WALL_CELL_SRC_PX, WALL_CELL_SRC_PX);
  for (const corner of QUADRANT_CORNERS) {
    const state = quadrantStateFromMask(canonicalMask, corner);
    const quadrant = quadrantKit.get(quadrantKitKey(corner, state));
    if (!quadrant) {
      throw new Error(`Missing quadrant kit entry for ${corner}:${state}`);
    }
    const origin = QUADRANT_ORIGIN[corner];
    compositeInto(cell, quadrant, origin.x, origin.y);
  }
  return cell;
}

/**
 * Compose and downsample the output (64x64) wall cell for `canonicalMask`.
 * Explicit source size (`WALL_CELL_SRC_PX`) and destination size
 * (`TERRAIN_PACK_CELL_PX`) are both passed to `nearestNeighborResize` — no
 * implicit scale-factor inference.
 */
export function composeWallCellOutput(
  canonicalMask: number,
  quadrantKit: ReadonlyMap<string, RgbaImage>,
): RgbaImage {
  const src = composeWallCellSrc(canonicalMask, quadrantKit);
  return nearestNeighborResize(src, TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX);
}
