/**
 * Sprite post-processor.
 *
 * Pure, deterministic transformation from a raw generated PNG to the
 * game-ready PNG that gets handed to sensors and (eventually) the engine.
 *
 * Steps, in this exact order:
 *   1. Background removal: 4-corner flood fill -> alpha 0 on reachable pixels.
 *   2. Resample: nearest-neighbor fit to brief.size (preserve aspect ratio).
 *   3. Palette quantize: snap each opaque pixel to its nearest palette entry
 *      by Euclidean RGB distance.
 *   4. Alpha hard-threshold: alpha > 128 -> 255, else -> 0.
 *
 * Purity contract:
 *   - No clocks (no Date.now, no performance.now).
 *   - No randomness (no Math.random; if you need ties broken, break them
 *     deterministically on index).
 *   - No environment reads (no process.env).
 *   - No filesystem access. The function takes the raw PNG bytes and returns
 *     the encoded result.
 *
 * Note on signature: the spec writes `(rawPng, brief) => Buffer`, but the brief
 * carries a palette *id*, not the resolved color list. To keep this function
 * pure (no disk reads to resolve the id), we accept the resolved palette as a
 * third argument. Callers (a Phase-2 driver) load the palette JSON once and
 * pass the colors in.
 */
import type { Brief, PaletteColors } from './brief-schema.js';
interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
export type SpeckleMode = 'edge-drop' | 'preserve-orphans' | 'disabled';
export interface PostprocessOptions {
  readonly background?: {
    readonly colorToleranceSq?: number;
    readonly fringeToleranceSq?: number;
  };
  readonly speckle?: {
    readonly minChannel?: number;
    readonly maxOpaqueNeighbors?: number;
    readonly dropEdgeOrphans?: boolean;
  };
  readonly modules?: {
    readonly speckleMode?: SpeckleMode;
  };
}
export declare function postprocess(
  rawPng: Buffer,
  brief: Brief,
  palette: PaletteColors,
  options?: PostprocessOptions,
): Buffer;
export interface PostprocessStepTrace {
  readonly id: string;
  readonly label: string;
  readonly png: Buffer;
}
export interface PostprocessTrace {
  readonly finalPng: Buffer;
  readonly steps: ReadonlyArray<PostprocessStepTrace>;
}
export declare function postprocessWithTrace(
  rawPng: Buffer,
  brief: Brief,
  palette: PaletteColors,
  options?: PostprocessOptions,
): PostprocessTrace;
/**
 * Replace isolated near-white opaque pixels (often random model speckles) with
 * the dominant neighboring opaque color. If none are found, only drop the
 * pixel when it is on a transparency edge; otherwise preserve interior pixels.
 */
export declare function removeIsolatedNearWhiteSpeckles(
  image: RgbaImage,
  opts?: {
    minChannel?: number;
    maxOpaqueNeighbors?: number;
    dropEdgeOrphans?: boolean;
  },
): RgbaImage;
/**
 * Mark every pixel reachable from any of the 4 corners (4-connected flood fill,
 * matching the corner pixel's RGB within `BACKGROUND_COLOR_TOLERANCE_SQ` in
 * squared Euclidean RGB distance) with alpha 0. Disconnected interior pixels
 * of the same color are preserved.
 *
 * The tolerance exists because model-generated PNGs rarely have a perfectly
 * uniform background — gpt-image-1 returns near-white with single-channel
 * deviations of 1-12 around the corners, which an exact-RGB flood fill misses
 * entirely (resulting in 100%-opaque sprites). 32 channels (≈ 12%) of squared
 * tolerance is conservative enough to leave saturated foreground intact
 * because foreground colors are typically ≥ ~80 channels away from white,
 * black, or magenta in any axis.
 *
 * Exported for direct unit testing.
 */
export declare const BACKGROUND_COLOR_TOLERANCE_SQ: number;
export declare const BACKGROUND_FRINGE_TOLERANCE_SQ: number;
export declare const BACKGROUND_B_COLOR_TOLERANCE_SQ = 4000;
export declare const BACKGROUND_B_FRINGE_TOLERANCE_SQ = 8000;
export declare const BACKGROUND_B_MAX_ENCLOSED_ISLAND_PIXELS = 256;
export declare const BACKGROUND_B_ENCLOSED_MAX_COMPONENT_DISTANCE_SQ = 25000;
export declare function removeBackground(image: RgbaImage, toleranceSq?: number): RgbaImage;
export declare function removeBackgroundB(
  image: RgbaImage,
  options?: {
    readonly colorToleranceSq?: number;
    readonly fringeToleranceSq?: number;
    readonly clearEnclosedIslands?: boolean;
  },
): RgbaImage;
/**
 * Snap every opaque pixel's RGB to the nearest palette entry by Euclidean
 * distance. Transparent pixels (alpha === 0) are left untouched in RGB and
 * keep alpha 0.
 *
 * Tie-breaking: the *first* palette entry at minimum distance wins. This
 * makes quantization deterministic regardless of palette order beyond ties.
 *
 * Exported for direct unit testing.
 */
export declare function quantizeToPalette(image: RgbaImage, palette: PaletteColors): RgbaImage;
/**
 * Force every alpha channel to either 0 or 255 using a 128 threshold.
 * Eliminates anti-aliased fringes that the generator might produce; the
 * post-processor never ships partially-transparent pixels.
 *
 * Exported for direct unit testing.
 */
export declare function hardThresholdAlpha(image: RgbaImage): RgbaImage;
/**
 * Trim fully-transparent rows and columns from all 4 edges.
 *
 * A row is "empty" if every pixel in it has alpha === 0.
 * A column is "empty" if every pixel in it has alpha === 0.
 *
 * Returns the cropped sub-image. If the image is entirely transparent,
 * returns a 0×0 image (callers should guard against this).
 *
 * Exported for direct unit testing.
 */
export declare function trimTransparentEdges(image: RgbaImage): RgbaImage;
/**
 * Nearest-neighbor upscale so that the smallest dimension equals `minPx`.
 * If the image is already >= minPx on both axes, returns unchanged.
 * Maintains aspect ratio (both axes scale by the same integer or fractional factor).
 *
 * Exported for direct unit testing.
 */
export declare function scaleToMinDimension(image: RgbaImage, minPx: number): RgbaImage;
export type { RgbaImage };
//# sourceMappingURL=postprocess.d.ts.map
