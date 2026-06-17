/**
 * Sensors — universal post-processed-sprite checks.
 *
 * A sensor is a pure, deterministic function that returns either
 *   {ok: true, sensor}        (sprite passes this check)
 *   {ok: false, sensor, reason, pixels?}  (sprite fails; reason is a stable
 *                                          short string, pixels is an
 *                                          optional debug list)
 *
 * Sensors NEVER:
 *   - read the clock
 *   - call Math.random
 *   - read environment variables
 *   - call out to a model
 *
 * If a check needs subjective judgment ("does this look like a sword?"), it
 * is an evaluator, not a sensor, and lives behind the sidecar.
 */
import type { Brief, PaletteColors, RgbTriple } from '../brief-schema.js';
export type Pixel = {
  x: number;
  y: number;
};
export type SensorOk = {
  ok: true;
  sensor: string;
};
export type SensorFail = {
  ok: false;
  sensor: string;
  reason: string;
  pixels?: ReadonlyArray<Pixel>;
};
export type SensorResult = SensorOk | SensorFail;
interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
export declare function decodeSprite(buffer: Buffer): RgbaImage;
export declare function dimensionsExact(image: RgbaImage, brief: Brief): SensorResult;
export declare function alphaBinary(
  image: RgbaImage,
  opts?: {
    maxReport?: number;
  },
): SensorResult;
export declare function paletteMembership(
  image: RgbaImage,
  palette: PaletteColors,
  opts?: {
    maxReport?: number;
  },
): SensorResult;
export declare function opaqueBboxFits(image: RgbaImage): SensorResult;
export declare function opaqueBboxFitsWithOptions(
  image: RgbaImage,
  opts?: {
    allowMainTouch?: boolean;
    allowDetachedEdgeComponents?: boolean;
    maxDetachedEdgePixels?: number;
  },
): SensorResult;
export declare function opaqueRatio(
  image: RgbaImage,
  opts?: {
    min?: number;
    max?: number;
  },
): SensorResult;
export declare function anchorOpaque(image: RgbaImage, brief: Brief): SensorResult;
/**
 * Run every universal sensor and return the full list of results. Callers
 * decide how to aggregate (fail-fast vs. report-all).
 */
export declare function universalSensors(
  image: RgbaImage,
  brief: Brief,
  palette: PaletteColors,
): SensorResult[];
export declare function gatherOpaquePixels(image: RgbaImage): Pixel[];
/**
 * Compute the angle (in radians, in [-π/2, π/2]) of the principal axis of a
 * point cloud. Uses the closed-form 2x2 covariance eigenvalue solution.
 *
 * Returns null if there are fewer than 2 points or all points are coincident.
 *
 * Exported because the weapon silhouette sensor uses this and it's worth unit
 * testing in isolation.
 */
export declare function principalAxisAngleRadians(points: ReadonlyArray<Pixel>): number | null;
export type { RgbaImage };
export type { RgbTriple };
//# sourceMappingURL=common.d.ts.map
