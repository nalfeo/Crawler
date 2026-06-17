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
export declare function deriveAnchor(
  image: RgbaImage,
  options?: DeriveAnchorOptions,
): DeriveAnchorResult;
export declare const DERIVE_ANCHOR_DEFAULTS: Required<DeriveAnchorOptions>;
//# sourceMappingURL=derive-anchor.d.ts.map
