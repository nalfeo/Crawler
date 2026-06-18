/**
 * PNG pixel-sampling utilities for e2e visual regression tests.
 *
 * Uses pngjs (already in devDependencies) to decode screenshot buffers and
 * read individual pixel colours.
 */
import { PNG } from 'pngjs';

export interface PixelRgb {
  r: number;
  g: number;
  b: number;
}

/** Decode a PNG screenshot buffer into a PNGjs object. */
export function parsePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

/** Read the RGB value of a single pixel at (x, y). */
export function readPixel(png: PNG, x: number, y: number): PixelRgb {
  const idx = (Math.round(y) * png.width + Math.round(x)) * 4;
  return {
    r: png.data[idx] ?? 0,
    g: png.data[idx + 1] ?? 0,
    b: png.data[idx + 2] ?? 0,
  };
}

/** Euclidean distance in RGB colour space. */
export function colorDist(a: PixelRgb, b: PixelRgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * Searches a rectangle inside the PNG for any pixel whose colour is within
 * `threshold` of `target`.  Useful for asserting that a colour appears
 * somewhere in a region without needing exact position.
 */
export function regionContainsColor(
  png: PNG,
  rect: { x: number; y: number; w: number; h: number },
  target: PixelRgb,
  threshold = 25,
): boolean {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(png.width - 1, rect.x + rect.w);
  const y1 = Math.min(png.height - 1, rect.y + rect.h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (colorDist(readPixel(png, x, y), target) < threshold) return true;
    }
  }
  return false;
}

/**
 * Counts how many sampled points in `points` have a colour that is NOT within
 * `threshold` of `voidColor`.  Returns the non-void count.
 */
export function countNonVoidPoints(
  png: PNG,
  points: Array<{ x: number; y: number }>,
  voidColor: PixelRgb,
  threshold = 20,
): number {
  return points.filter(({ x, y }) => colorDist(readPixel(png, x, y), voidColor) > threshold).length;
}
