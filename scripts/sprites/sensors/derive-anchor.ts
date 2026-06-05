/**
 * Per-variant anchor derivation.
 *
 * The old `anchor-opaque` sensor demands that every variant have an opaque
 * pixel at a single static `(brief.anchor.x, brief.anchor.y)`. That's the
 * right contract for chunky bottom-center hafts (skull-mace) but fails for
 * slender weapons (katana) where the grip lands somewhere in [x=2..x=11]
 * across the sheet — no single pixel is opaque in more than a handful of
 * variants regardless of art quality.
 *
 * The correct contract for a handheld weapon is "the sprite has a graspable
 * bottom-center grip pixel — find it". The anchor is a semantic property of
 * the silhouette, derivable from pixels, not a brief input the author has to
 * guess.
 *
 * This module is the pure derivation. It takes a decoded RGBA image, walks
 * the bottom band of rows looking for the first opaque row, picks the
 * horizontal opaque run whose midpoint is closest to the frame's horizontal
 * center, and returns that midpoint as `{x, y}`. If no opaque pixel exists
 * within the band, or the chosen midpoint is too far from center, it returns
 * a null anchor and a stable diagnostic reason.
 *
 * Purity contract — same as the rest of `sensors/`:
 *   - no clocks / no Math.random / no env reads / no IO
 *   - deterministic given (image, options)
 */

import type { RgbaImage } from './common.js';

export interface DeriveAnchorOptions {
  /**
   * How many rows up from the bottom edge are eligible to contain the grip.
   * If the first opaque pixel is outside this band, the sprite is floating
   * or clipped and we refuse to derive an anchor. Default 4 rows.
   */
  readonly bandRows?: number;
  /**
   * Maximum allowed horizontal distance (in pixels) between the chosen
   * grip-run midpoint and `floor(width / 2)`. A hard-left or hard-right grip
   * means the sprite doesn't read as bottom-center handheld. Default 3.
   */
  readonly centerToleranceX?: number;
}

export interface DerivedAnchor {
  readonly x: number;
  readonly y: number;
}

export interface DeriveAnchorResult {
  /** Derived anchor pixel, or null when the algorithm refuses to derive one. */
  readonly anchor: DerivedAnchor | null;
  /** Stable, short diagnostic — null on success. */
  readonly reason: string | null;
}

const DEFAULT_BAND_ROWS = 4;
const DEFAULT_CENTER_TOLERANCE_X = 3;

interface OpaqueRun {
  readonly start: number;
  readonly end: number;
}

/**
 * Derive the anchor pixel for a single post-processed sprite.
 *
 * Algorithm:
 *   1. Scan rows from `y = height - 1` upward, stopping at the first row
 *      containing any opaque pixel — call it `gripRowY`.
 *   2. If `gripRowY < height - bandRows`, the silhouette is floating /
 *      clipped: return null with a `no opaque pixel in bottom N rows` reason.
 *   3. Identify every contiguous opaque horizontal run on `gripRowY`. Choose
 *      the run whose midpoint is closest to `floor(width / 2)` (ties broken
 *      toward the lower-x run for determinism).
 *   4. `midpointX = floor((runStart + runEnd) / 2)`.
 *   5. If `|midpointX - floor(width / 2)| > centerToleranceX`, the grip is
 *      hard-left or hard-right: return null with a `grip midpoint x=M is
 *      outside ±T of center C` reason.
 *   6. Otherwise return `{ x: midpointX, y: gripRowY }`.
 */
export function deriveAnchor(
  image: RgbaImage,
  options: DeriveAnchorOptions = {},
): DeriveAnchorResult {
  const bandRows = options.bandRows ?? DEFAULT_BAND_ROWS;
  const centerToleranceX = options.centerToleranceX ?? DEFAULT_CENTER_TOLERANCE_X;
  const { width, height } = image;

  if (width <= 0 || height <= 0) {
    return { anchor: null, reason: `image has zero pixels (${width}x${height})` };
  }

  // 1) Scan bottom-up for the first row with any opaque pixel.
  let gripRowY = -1;
  for (let y = height - 1; y >= 0; y--) {
    if (rowHasOpaque(image, y)) {
      gripRowY = y;
      break;
    }
  }

  if (gripRowY === -1) {
    return { anchor: null, reason: 'no opaque pixels in image' };
  }

  // 2) Must be inside the bottom band.
  const bandTop = height - bandRows;
  if (gripRowY < bandTop) {
    return {
      anchor: null,
      reason: `no opaque pixel in bottom ${bandRows} rows (first opaque row y=${gripRowY})`,
    };
  }

  // 3) Pick the opaque run on gripRowY whose midpoint is closest to center.
  const runs = opaqueRunsOnRow(image, gripRowY);
  if (runs.length === 0) {
    // Defensive — rowHasOpaque returned true, so this branch is unreachable.
    return { anchor: null, reason: `internal: no opaque runs on row ${gripRowY}` };
  }
  const centerX = Math.floor(width / 2);
  const chosen = pickRunClosestToCenter(runs, centerX);

  // 4) Compute the midpoint x.
  const midpointX = Math.floor((chosen.start + chosen.end) / 2);

  // 5) Centeredness check.
  const dx = Math.abs(midpointX - centerX);
  if (dx > centerToleranceX) {
    return {
      anchor: null,
      reason: `grip midpoint x=${midpointX} is outside ±${centerToleranceX} of center ${centerX}`,
    };
  }

  // 6) Success.
  return { anchor: { x: midpointX, y: gripRowY }, reason: null };
}

function rowHasOpaque(image: RgbaImage, y: number): boolean {
  const rowStart = y * image.width * 4;
  for (let x = 0; x < image.width; x++) {
    const a = image.data[rowStart + x * 4 + 3] ?? 0;
    if (a !== 0) return true;
  }
  return false;
}

function opaqueRunsOnRow(image: RgbaImage, y: number): OpaqueRun[] {
  const out: OpaqueRun[] = [];
  const rowStart = y * image.width * 4;
  let runStart = -1;
  for (let x = 0; x < image.width; x++) {
    const a = image.data[rowStart + x * 4 + 3] ?? 0;
    if (a !== 0) {
      if (runStart === -1) runStart = x;
    } else if (runStart !== -1) {
      out.push({ start: runStart, end: x - 1 });
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    out.push({ start: runStart, end: image.width - 1 });
  }
  return out;
}

function pickRunClosestToCenter(runs: ReadonlyArray<OpaqueRun>, centerX: number): OpaqueRun {
  let best = runs[0]!;
  let bestDist = Math.abs(Math.floor((best.start + best.end) / 2) - centerX);
  for (let i = 1; i < runs.length; i++) {
    const r = runs[i]!;
    const mid = Math.floor((r.start + r.end) / 2);
    const dist = Math.abs(mid - centerX);
    // Strict < keeps the earlier (lower-x) run on ties — deterministic.
    if (dist < bestDist) {
      best = r;
      bestDist = dist;
    }
  }
  return best;
}

export const DERIVE_ANCHOR_DEFAULTS: Required<DeriveAnchorOptions> = Object.freeze({
  bandRows: DEFAULT_BAND_ROWS,
  centerToleranceX: DEFAULT_CENTER_TOLERANCE_X,
});
