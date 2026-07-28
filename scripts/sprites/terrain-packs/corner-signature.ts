/**
 * Shared corner-signature helpers — the corner-side counterpart to
 * `edge-signature.ts`.
 *
 * Why this exists
 * ---------------
 * The compatible-boundary check in `validate.ts` samples only the four
 * CARDINAL edge bands of each cell. That check is structurally blind to
 * diagonal (corner) information: a 16-tile, cardinal-only autotile sheet
 * replicated across the 47 blob47 slots scores a perfect 1.000 on it, because
 * every cell whose four cardinal bits agree looks identical along all four
 * edges. Two real regressions shipped through that blind spot (see
 * `validateCompatibleCorners`), so corner coverage is now gated explicitly.
 *
 * What is sampled
 * ---------------
 * A small square at each of the four extreme corners of the cell, classified
 * wall-like vs floor-like against the mask-0 (all corners floor) and mask-255
 * (all corners wall) reference cells — the same two-reference nearest-match
 * scheme the edge check uses. The expected value comes from
 * `cornerIsWallFromMask` in `src/shared/terrain-pack-mask.ts`, which is the
 * single shared definition of blob47 corner semantics.
 *
 * The sample square must be strictly smaller than the art's corner
 * inset/nick so that a nicked corner reads unambiguously as floor; both
 * configs below are sized against the 64px output cell.
 */
import { cornerIsWallFromMask, QUADRANT_CORNERS } from '../../../src/shared/terrain-pack-mask.js';
import type { QuadrantCorner } from '../../../src/shared/terrain-pack-mask.js';
import { cropImage, type RgbaImage } from './png-buffer.js';
import {
  sampleSignature,
  signatureDistance,
  ZERO_SIGNATURE,
  type SampleSignature,
} from './sample-signature.js';

export type CellCorner = QuadrantCorner;
export const CELL_CORNERS: readonly CellCorner[] = QUADRANT_CORNERS;

export interface CornerSamplingConfig {
  /** Side length of the square corner sample, as a fraction of the cell size. */
  readonly sampleFraction: number;
}

/**
 * Authored (quadrant-kit) packs: the corner nick is `WALL_INSET_PX` = 48/256 =
 * 18.75% of the cell. A 9% sample sits well inside that nick, so a nicked
 * corner reads as unambiguously floor and a solid corner as unambiguously wall.
 */
export const AUTHORED_CORNER_SAMPLING: CornerSamplingConfig = { sampleFraction: 0.09 };

/**
 * Vendored line-art packs: hand-drawn corners are softer and anti-aliased, so a
 * slightly larger sample averages out stray guide pixels without reaching past
 * the drawn corner feature.
 */
export const VENDORED_CORNER_SAMPLING: CornerSamplingConfig = { sampleFraction: 0.15 };

/** Crop the square sample at one extreme corner of a (square) cell. */
function sampleCornerSquare(
  cell: RgbaImage,
  corner: CellCorner,
  config: CornerSamplingConfig,
): RgbaImage {
  const size = cell.width;
  const side = Math.max(2, Math.round(size * config.sampleFraction));
  const far = size - side;
  switch (corner) {
    case 'NW':
      return cropImage(cell, 0, 0, side, side);
    case 'NE':
      return cropImage(cell, far, 0, side, side);
    case 'SE':
      return cropImage(cell, far, far, side, side);
    case 'SW':
      return cropImage(cell, 0, far, side, side);
  }
}

/** Per-corner floor/wall reference signatures derived from two reference cells. */
export interface CornerReferences {
  readonly floor: Readonly<Record<CellCorner, SampleSignature>>;
  readonly wall: Readonly<Record<CellCorner, SampleSignature>>;
}

export function buildCornerReferences(
  floorRefCell: RgbaImage,
  wallRefCell: RgbaImage,
  config: CornerSamplingConfig,
): CornerReferences {
  const floor: Record<CellCorner, SampleSignature> = {
    NW: ZERO_SIGNATURE,
    NE: ZERO_SIGNATURE,
    SE: ZERO_SIGNATURE,
    SW: ZERO_SIGNATURE,
  };
  const wall: Record<CellCorner, SampleSignature> = {
    NW: ZERO_SIGNATURE,
    NE: ZERO_SIGNATURE,
    SE: ZERO_SIGNATURE,
    SW: ZERO_SIGNATURE,
  };
  for (const corner of CELL_CORNERS) {
    floor[corner] = sampleSignature(sampleCornerSquare(floorRefCell, corner, config));
    wall[corner] = sampleSignature(sampleCornerSquare(wallRefCell, corner, config));
  }
  return { floor, wall };
}

/** Classify each corner of `cell` as wall-like (true) or floor-like (false). */
export function classifyCellCorners(
  cell: RgbaImage,
  refs: CornerReferences,
  config: CornerSamplingConfig,
): Record<CellCorner, boolean> {
  const out: Record<CellCorner, boolean> = { NW: false, NE: false, SE: false, SW: false };
  for (const corner of CELL_CORNERS) {
    const sig = sampleSignature(sampleCornerSquare(cell, corner, config));
    out[corner] =
      signatureDistance(sig, refs.wall[corner]) < signatureDistance(sig, refs.floor[corner]);
  }
  return out;
}

/** Expected wall/floor value for every corner of a canonical mask. */
export function expectedCorners(maskId: number): Readonly<Record<CellCorner, boolean>> {
  const out: Record<CellCorner, boolean> = { NW: false, NE: false, SE: false, SW: false };
  for (const corner of CELL_CORNERS) {
    out[corner] = cornerIsWallFromMask(maskId, corner);
  }
  return out;
}
