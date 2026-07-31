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
import { resizeSpriteStrategy } from '../size-variants.js';

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
  // When trimAndFit is enabled, output dimensions are dynamic — skip this sensor.
  if (brief.postprocessing?.trimAndFit) {
    return ok(sensor);
  }
  const strategy = resizeSpriteStrategy(
    brief.type,
    brief.size.width,
    brief.size.height,
    brief.frameSequence?.enabled,
  );
  if (strategy === 'width') {
    if (image.width !== brief.size.width) {
      return fail(
        sensor,
        `expected width ${brief.size.width} for double-wide sprite, got ${image.width}x${image.height}`,
      );
    }
    return ok(sensor);
  }
  if (strategy === 'height') {
    if (image.height !== brief.size.height) {
      return fail(
        sensor,
        `expected height ${brief.size.height} for tall sprite, got ${image.width}x${image.height}`,
      );
    }
    return ok(sensor);
  }
  if (strategy === 'cover') {
    if (image.width < brief.size.width || image.height < brief.size.height) {
      return fail(
        sensor,
        `expected at least ${brief.size.width}x${brief.size.height} for large sprite occupancy, got ${image.width}x${image.height}`,
      );
    }
    return ok(sensor);
  }
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
  return opaqueBboxFitsWithOptions(image);
}

interface EdgeTouchOptions {
  readonly allowMainTouch: boolean;
  readonly allowDetachedEdgeComponents: boolean;
  readonly maxDetachedEdgePixels: number;
}

interface OpaqueComponent {
  readonly area: number;
  readonly touchesEdge: boolean;
  readonly edgePixels: ReadonlyArray<Pixel>;
}

interface EdgeAnalysis {
  readonly ok: boolean;
  readonly reason: string;
  readonly pixels?: ReadonlyArray<Pixel>;
}

export function opaqueBboxFitsWithOptions(
  image: RgbaImage,
  opts: {
    allowMainTouch?: boolean;
    allowDetachedEdgeComponents?: boolean;
    maxDetachedEdgePixels?: number;
  } = {},
): SensorResult {
  const sensor = 'opaque-bbox-fits';
  const edgeAnalysis = analyzeEdgeTouchingComponents(image, {
    allowMainTouch: opts.allowMainTouch ?? false,
    allowDetachedEdgeComponents: opts.allowDetachedEdgeComponents ?? false,
    maxDetachedEdgePixels: opts.maxDetachedEdgePixels ?? 0,
  });
  if (!edgeAnalysis.ok) {
    return fail(sensor, edgeAnalysis.reason, edgeAnalysis.pixels);
  }
  return ok(sensor);
}

function analyzeEdgeTouchingComponents(image: RgbaImage, opts: EdgeTouchOptions): EdgeAnalysis {
  const components = extractOpaqueComponents(image);
  if (components.length === 0) {
    return { ok: false, reason: 'no opaque pixels - sprite is empty' };
  }
  let largestIdx = 0;
  for (let i = 1; i < components.length; i++) {
    if (components[i]!.area > components[largestIdx]!.area) largestIdx = i;
  }
  const largest = components[largestIdx]!;
  if (largest.touchesEdge && !opts.allowMainTouch) {
    return {
      ok: false,
      reason: `main silhouette touches frame edge (${image.width}x${image.height})`,
      pixels: largest.edgePixels,
    };
  }
  for (let i = 0; i < components.length; i++) {
    if (i === largestIdx) continue;
    const c = components[i]!;
    if (!c.touchesEdge) continue;
    if (!opts.allowDetachedEdgeComponents) {
      return {
        ok: false,
        reason: `detached edge artifact detected (area=${c.area})`,
        pixels: c.edgePixels,
      };
    }
    if (c.area > opts.maxDetachedEdgePixels) {
      return {
        ok: false,
        reason:
          `detached edge artifact exceeds allowance (` +
          `area=${c.area}, max=${opts.maxDetachedEdgePixels})`,
        pixels: c.edgePixels,
      };
    }
  }
  return { ok: true, reason: 'ok' };
}

function extractOpaqueComponents(image: RgbaImage): OpaqueComponent[] {
  const width = image.width;
  const height = image.height;
  const visited = new Uint8Array(width * height);
  const components: OpaqueComponent[] = [];
  const queueX: number[] = [];
  const queueY: number[] = [];
  const push = (x: number, y: number) => {
    queueX.push(x);
    queueY.push(y);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] === 1 || !isOpaque(image, x, y)) continue;
      visited[idx] = 1;
      queueX.length = 0;
      queueY.length = 0;
      push(x, y);
      let area = 0;
      let touchesEdge = false;
      const edgePixels: Pixel[] = [];
      for (let q = 0; q < queueX.length; q++) {
        const cx = queueX[q]!;
        const cy = queueY[q]!;
        area += 1;
        if (isFrameEdge(cx, cy, width, height)) {
          touchesEdge = true;
          if (edgePixels.length < 16) edgePixels.push({ x: cx, y: cy });
        }
        const neighbors: ReadonlyArray<readonly [number, number]> = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (visited[nIdx] === 1 || !isOpaque(image, nx, ny)) continue;
          visited[nIdx] = 1;
          push(nx, ny);
        }
      }
      components.push({ area, touchesEdge, edgePixels });
    }
  }
  return components;
}

function isOpaque(image: RgbaImage, x: number, y: number): boolean {
  const a = image.data[(y * image.width + x) * 4 + 3] ?? 0;
  return a !== 0;
}

function isFrameEdge(x: number, y: number, width: number, height: number): boolean {
  return x === 0 || y === 0 || x === width - 1 || y === height - 1;
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

export function interiorTransparencyHoles(
  image: RgbaImage,
  opts: { maxPixels?: number; maxReport?: number } = {},
): SensorResult {
  const sensor = 'interior-transparency-holes';
  const maxPixels = opts.maxPixels ?? 0;
  const maxReport = opts.maxReport ?? 16;
  const stats = gatherOpaqueStats(image);
  if (stats.count === 0) return ok(sensor);
  const minX = stats.minX;
  const maxX = stats.maxX;
  const minY = stats.minY;
  const maxY = stats.maxY;
  const width = image.width;
  const height = image.height;
  const visited = new Uint8Array(width * height);
  const qx: number[] = [];
  const qy: number[] = [];
  const push = (x: number, y: number): void => {
    const idx = y * width + x;
    if (visited[idx] === 1 || isOpaque(image, x, y)) return;
    visited[idx] = 1;
    qx.push(x);
    qy.push(y);
  };
  // Flood transparent exterior from the bounding-box perimeter.
  for (let x = minX; x <= maxX; x++) {
    push(x, minY);
    push(x, maxY);
  }
  for (let y = minY; y <= maxY; y++) {
    push(minX, y);
    push(maxX, y);
  }
  for (let i = 0; i < qx.length; i++) {
    const x = qx[i]!;
    const y = qy[i]!;
    const neighbors: ReadonlyArray<readonly [number, number]> = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      push(nx, ny);
    }
  }

  const holes: Pixel[] = [];
  let holeCount = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = y * width + x;
      if (isOpaque(image, x, y) || visited[idx] === 1) continue;
      holeCount += 1;
      if (holes.length < maxReport) holes.push({ x, y });
    }
  }
  if (holeCount > maxPixels) {
    return fail(
      sensor,
      `found ${holeCount} enclosed transparent interior pixels (max ${maxPixels})`,
      holes,
    );
  }
  return ok(sensor);
}

export function anchorOpaque(image: RgbaImage, brief: Brief): SensorResult {
  const sensor = 'anchor-opaque';
  // When trimAndFit is on, the image dimensions change so the brief's static
  // anchor coords are meaningless. Skip — anchor-derivable handles validation.
  if (brief.postprocessing?.trimAndFit) {
    return ok(sensor);
  }
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
  // When trimAndFit is enabled, the opaque ratio naturally increases
  // since transparent padding was removed. Use a more permissive max.
  const opaqueMax = brief.postprocessing?.trimAndFit ? 0.92 : 0.65;
  return [
    dimensionsExact(image, brief),
    alphaBinary(image),
    paletteMembership(image, palette),
    opaqueBboxFits(image),
    opaqueRatio(image, { max: opaqueMax }),
    interiorTransparencyHoles(image),
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
