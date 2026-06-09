/**
 * Sprite post-processor.
 *
 * Pure, deterministic transformation from a raw generated PNG to the
 * game-ready PNG that gets handed to sensors and (eventually) the engine.
 *
 * Steps, in this exact order:
 *   1. Background removal: 4-corner flood fill -> alpha 0 on reachable pixels.
 *   2. Downscale: nearest-neighbor resample to brief.size.
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

import { PNG } from 'pngjs';
import type { Brief, PaletteColors, RgbTriple } from './brief-schema.js';

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export function postprocess(rawPng: Buffer, brief: Brief, palette: PaletteColors): Buffer {
  if (palette.length === 0) {
    throw new Error('postprocess: palette must contain at least one color');
  }

  const decoded = decodePng(rawPng);
  const bgRemoved = removeBackground(decoded);
  const scaled = downscaleNearest(bgRemoved, brief.size.width, brief.size.height);
  const quantized = quantizeToPalette(scaled, palette);
  const finalised = hardThresholdAlpha(quantized);

  // Optional trim-and-fit: remove dead transparent edges, then scale up
  // so the smallest dimension hits minDimension.
  if (brief.postprocessing?.trimAndFit) {
    const trimmed = trimTransparentEdges(finalised);
    if (trimmed.width > 0 && trimmed.height > 0) {
      const minDim = brief.postprocessing.minDimension ?? 64;
      const fitted = scaleToMinDimension(trimmed, minDim);
      return encodePng(fitted);
    }
  }

  return encodePng(finalised);
}

function decodePng(buffer: Buffer): RgbaImage {
  const png = PNG.sync.read(buffer);
  // pngjs gives us a Buffer; treat it as a Uint8Array view so the rest of the
  // pipeline is buffer-agnostic.
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
}

function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

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
export const BACKGROUND_COLOR_TOLERANCE_SQ = 32 * 32; // squared Euclidean RGB tolerance

export function removeBackground(image: RgbaImage): RgbaImage {
  const { width, height } = image;
  const out = new Uint8Array(image.data);
  const total = width * height;
  if (total === 0) return { width, height, data: out };

  const visited = new Uint8Array(total);
  const corners: ReadonlyArray<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];

  for (const [cx, cy] of corners) {
    const cIdx = (cy * width + cx) * 4;
    const cr = out[cIdx] ?? 0;
    const cg = out[cIdx + 1] ?? 0;
    const cb = out[cIdx + 2] ?? 0;
    const ca = out[cIdx + 3] ?? 0;
    // If the corner is already transparent, there's nothing meaningful to
    // flood — but we still mark it transparent so the result is idempotent.
    if (ca === 0) {
      out[cIdx + 3] = 0;
      visited[cy * width + cx] = 1;
      continue;
    }
    floodFill(out, visited, width, height, cx, cy, cr, cg, cb);
  }

  return { width, height, data: out };
}

function floodFill(
  data: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  r: number,
  g: number,
  b: number,
): void {
  // Iterative stack-based 4-connected flood fill. We avoid recursion so this
  // works on large images without blowing the call stack.
  const stack: number[] = [startX, startY];
  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const linear = y * width + x;
    if (visited[linear]) continue;
    const idx = linear * 4;
    const dr = (data[idx] ?? 0) - r;
    const dg = (data[idx + 1] ?? 0) - g;
    const db = (data[idx + 2] ?? 0) - b;
    if (dr * dr + dg * dg + db * db > BACKGROUND_COLOR_TOLERANCE_SQ) continue;
    visited[linear] = 1;
    data[idx + 3] = 0;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
}

/**
 * Nearest-neighbor downscale (or upscale, but we never upscale in practice).
 * For each destination pixel, sample the source pixel whose center maps to it.
 *
 * Determinism: tie-breaking falls out of integer truncation in a fixed order;
 * no random or floating-point comparisons are used.
 *
 * Internal helper — exercised end-to-end via `postprocess`.
 */
function downscaleNearest(image: RgbaImage, dstW: number, dstH: number): RgbaImage {
  const { width: srcW, height: srcH, data: src } = image;
  const dst = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(((y + 0.5) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(((x + 0.5) * srcW) / dstW));
      const srcIdx = (sy * srcW + sx) * 4;
      const dstIdx = (y * dstW + x) * 4;
      dst[dstIdx] = src[srcIdx] ?? 0;
      dst[dstIdx + 1] = src[srcIdx + 1] ?? 0;
      dst[dstIdx + 2] = src[srcIdx + 2] ?? 0;
      dst[dstIdx + 3] = src[srcIdx + 3] ?? 0;
    }
  }
  return { width: dstW, height: dstH, data: dst };
}

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
export function quantizeToPalette(image: RgbaImage, palette: PaletteColors): RgbaImage {
  if (palette.length === 0) {
    throw new Error('quantizeToPalette: palette must be non-empty');
  }
  const { width, height, data: src } = image;
  const dst = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] ?? 0;
    if (a === 0) {
      // preserve transparent pixels, including their RGB (avoids leaking
      // bg color into anything that later inspects raw RGB)
      dst[i] = src[i] ?? 0;
      dst[i + 1] = src[i + 1] ?? 0;
      dst[i + 2] = src[i + 2] ?? 0;
      dst[i + 3] = 0;
      continue;
    }
    const r = src[i] ?? 0;
    const g = src[i + 1] ?? 0;
    const b = src[i + 2] ?? 0;
    const nearest = nearestPaletteEntry(r, g, b, palette);
    dst[i] = nearest[0];
    dst[i + 1] = nearest[1];
    dst[i + 2] = nearest[2];
    dst[i + 3] = a;
  }
  return { width, height, data: dst };
}

function nearestPaletteEntry(r: number, g: number, b: number, palette: PaletteColors): RgbTriple {
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i] as RgbTriple;
    const dr = r - c[0];
    const dg = g - c[1];
    const db = b - c[2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
      if (dist === 0) break; // exact match; no need to continue
    }
  }
  return palette[bestIdx] as RgbTriple;
}

/**
 * Force every alpha channel to either 0 or 255 using a 128 threshold.
 * Eliminates anti-aliased fringes that the generator might produce; the
 * post-processor never ships partially-transparent pixels.
 *
 * Exported for direct unit testing.
 */
export function hardThresholdAlpha(image: RgbaImage): RgbaImage {
  const { width, height, data: src } = image;
  const dst = new Uint8Array(src);
  for (let i = 3; i < dst.length; i += 4) {
    dst[i] = (dst[i] ?? 0) > 128 ? 255 : 0;
  }
  return { width, height, data: dst };
}

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
export function trimTransparentEdges(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;
  if (width === 0 || height === 0) return { width: 0, height: 0, data: new Uint8Array(0) };

  // Find bounding box of non-transparent pixels.
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3] ?? 0;
      if (a > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  // Entirely transparent — return empty.
  if (bottom === -1) return { width: 0, height: 0, data: new Uint8Array(0) };

  const newW = right - left + 1;
  const newH = bottom - top + 1;
  const dst = new Uint8Array(newW * newH * 4);
  for (let y = 0; y < newH; y++) {
    const srcRow = (top + y) * width + left;
    const dstRow = y * newW;
    for (let x = 0; x < newW; x++) {
      const si = (srcRow + x) * 4;
      const di = (dstRow + x) * 4;
      dst[di] = data[si] ?? 0;
      dst[di + 1] = data[si + 1] ?? 0;
      dst[di + 2] = data[si + 2] ?? 0;
      dst[di + 3] = data[si + 3] ?? 0;
    }
  }
  return { width: newW, height: newH, data: dst };
}

/**
 * Nearest-neighbor upscale so that the smallest dimension equals `minPx`.
 * If the image is already >= minPx on both axes, returns unchanged.
 * Maintains aspect ratio (both axes scale by the same integer or fractional factor).
 *
 * Exported for direct unit testing.
 */
export function scaleToMinDimension(image: RgbaImage, minPx: number): RgbaImage {
  const { width, height } = image;
  if (width === 0 || height === 0) return image;
  const minCurrent = Math.min(width, height);
  if (minCurrent >= minPx) return image;

  const scale = minPx / minCurrent;
  const dstW = Math.round(width * scale);
  const dstH = Math.round(height * scale);
  // Reuse the existing nearest-neighbor scaler (it handles up AND down).
  return upscaleNearest(image, dstW, dstH);
}

/**
 * Nearest-neighbor scale (works for both up and down). Same deterministic
 * logic as downscaleNearest but as a separate export for clarity.
 */
function upscaleNearest(image: RgbaImage, dstW: number, dstH: number): RgbaImage {
  const { width: srcW, height: srcH, data: src } = image;
  const dst = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(((y + 0.5) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(((x + 0.5) * srcW) / dstW));
      const srcIdx = (sy * srcW + sx) * 4;
      const dstIdx = (y * dstW + x) * 4;
      dst[dstIdx] = src[srcIdx] ?? 0;
      dst[dstIdx + 1] = src[srcIdx + 1] ?? 0;
      dst[dstIdx + 2] = src[srcIdx + 2] ?? 0;
      dst[dstIdx + 3] = src[srcIdx + 3] ?? 0;
    }
  }
  return { width: dstW, height: dstH, data: dst };
}

// Re-export the internal image type so tests can build images without going
// through PNG encoding/decoding.
export type { RgbaImage };
