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

import { PNG } from 'pngjs';
import type { Brief, PaletteColors, RgbTriple } from '../brief-schema.js';

export type Pixel = { x: number; y: number };

export type SensorOk = { ok: true; sensor: string };
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

export function decodeSprite(buffer: Buffer): RgbaImage {
  const png = PNG.sync.read(buffer);
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
}

const ok = (sensor: string): SensorOk => ({ ok: true, sensor });
const fail = (sensor: string, reason: string, pixels?: ReadonlyArray<Pixel>): SensorFail =>
  pixels === undefined ? { ok: false, sensor, reason } : { ok: false, sensor, reason, pixels };

export function dimensionsExact(image: RgbaImage, brief: Brief): SensorResult {
  const sensor = 'dimensions-exact';
  if (image.width !== brief.size.width || image.height !== brief.size.height) {
    return fail(
      sensor,
      `expected ${brief.size.width}x${brief.size.height}, got ${image.width}x${image.height}`,
    );
  }
  return ok(sensor);
}

export function alphaBinary(image: RgbaImage, opts: { maxReport?: number } = {}): SensorResult {
  const sensor = 'alpha-binary';
  const max = opts.maxReport ?? 16;
  const offenders: Pixel[] = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const a = image.data[(y * image.width + x) * 4 + 3] ?? 0;
      if (a !== 0 && a !== 255) {
        if (offenders.length < max) offenders.push({ x, y });
        else break;
      }
    }
    if (offenders.length >= max) break;
  }
  if (offenders.length > 0) {
    return fail(
      sensor,
      `found at least ${offenders.length} pixels with alpha not in {0, 255}`,
      offenders,
    );
  }
  return ok(sensor);
}

export function paletteMembership(
  image: RgbaImage,
  palette: PaletteColors,
  opts: { maxReport?: number } = {},
): SensorResult {
  const sensor = 'palette-membership';
  const max = opts.maxReport ?? 16;
  const set = new Set<number>();
  for (const c of palette) {
    set.add(packRgb(c[0], c[1], c[2]));
  }
  const offenders: Pixel[] = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const idx = (y * image.width + x) * 4;
      const a = image.data[idx + 3] ?? 0;
      if (a === 0) continue;
      const r = image.data[idx] ?? 0;
      const g = image.data[idx + 1] ?? 0;
      const b = image.data[idx + 2] ?? 0;
      if (!set.has(packRgb(r, g, b))) {
        if (offenders.length < max) offenders.push({ x, y });
        else break;
      }
    }
    if (offenders.length >= max) break;
  }
  if (offenders.length > 0) {
    return fail(sensor, `at least ${offenders.length} opaque pixels are off-palette`, offenders);
  }
  return ok(sensor);
}

interface OpaqueStats {
  readonly count: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

function gatherOpaqueStats(image: RgbaImage): OpaqueStats {
  let count = 0;
  let minX = image.width;
  let maxX = -1;
  let minY = image.height;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const a = image.data[(y * image.width + x) * 4 + 3] ?? 0;
      if (a === 0) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, minX, maxX, minY, maxY };
}

export function opaqueBboxFits(image: RgbaImage): SensorResult {
  const sensor = 'opaque-bbox-fits';
  const stats = gatherOpaqueStats(image);
  if (stats.count === 0) {
    return fail(sensor, 'no opaque pixels — sprite is empty');
  }
  if (stats.minX < 0 || stats.maxX >= image.width || stats.minY < 0 || stats.maxY >= image.height) {
    return fail(
      sensor,
      `opaque bbox [${stats.minX}..${stats.maxX}] x [${stats.minY}..${stats.maxY}] outside frame ${image.width}x${image.height}`,
    );
  }
  return ok(sensor);
}

export function opaqueRatio(
  image: RgbaImage,
  opts: { min?: number; max?: number } = {},
): SensorResult {
  const sensor = 'opaque-ratio';
  const min = opts.min ?? 0.1;
  const max = opts.max ?? 0.65;
  const total = image.width * image.height;
  if (total === 0) return fail(sensor, 'image has zero pixels');
  const stats = gatherOpaqueStats(image);
  const ratio = stats.count / total;
  if (ratio < min || ratio > max) {
    return fail(sensor, `opaque ratio ${ratio.toFixed(3)} outside [${min}, ${max}]`);
  }
  return ok(sensor);
}

export function anchorOpaque(image: RgbaImage, brief: Brief): SensorResult {
  const sensor = 'anchor-opaque';
  const { x, y } = brief.anchor;
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) {
    return fail(sensor, `anchor (${x}, ${y}) out of bounds for ${image.width}x${image.height}`);
  }
  const a = image.data[(y * image.width + x) * 4 + 3] ?? 0;
  if (a !== 255) {
    return fail(sensor, `anchor pixel (${x}, ${y}) is not opaque`, [{ x, y }]);
  }
  return ok(sensor);
}

/**
 * Run every universal sensor and return the full list of results. Callers
 * decide how to aggregate (fail-fast vs. report-all).
 */
export function universalSensors(
  image: RgbaImage,
  brief: Brief,
  palette: PaletteColors,
): SensorResult[] {
  return [
    dimensionsExact(image, brief),
    alphaBinary(image),
    paletteMembership(image, palette),
    opaqueBboxFits(image),
    opaqueRatio(image),
    anchorOpaque(image, brief),
  ];
}

function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

// ---------------------------------------------------------------------------
// Helpers exported for weapon-specific sensors and tests.

export function gatherOpaquePixels(image: RgbaImage): Pixel[] {
  const out: Pixel[] = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const a = image.data[(y * image.width + x) * 4 + 3] ?? 0;
      if (a !== 0) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Compute the angle (in radians, in [-π/2, π/2]) of the principal axis of a
 * point cloud. Uses the closed-form 2x2 covariance eigenvalue solution.
 *
 * Returns null if there are fewer than 2 points or all points are coincident.
 *
 * Exported because the weapon silhouette sensor uses this and it's worth unit
 * testing in isolation.
 */
export function principalAxisAngleRadians(points: ReadonlyArray<Pixel>): number | null {
  if (points.length < 2) return null;
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / points.length;
  const meanY = sumY / points.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 && syy === 0) return null;
  // Principal axis direction: angle of eigenvector with the larger eigenvalue.
  // For a 2x2 symmetric matrix [[sxx, sxy],[sxy, syy]], θ = 0.5 * atan2(2*sxy, sxx - syy).
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

export type { RgbaImage };
export type { RgbTriple };
