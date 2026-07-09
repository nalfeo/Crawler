/**
 * Fixture builders for the sprite pipeline integration tests.
 *
 * Each builder produces a 1024x1024 raw PNG buffer that simulates a
 * just-generated weapon sprite on a solid corner-removable background.
 * The integration test runs the real post-processor on these fixtures and
 * asserts the real sensors' verdicts.
 *
 * Why builders instead of checked-in PNG binaries: the recipe is reviewable
 * and diffable in plain TypeScript; binary fixtures aren't. The fixtures
 * are deterministic, so two runs produce byte-identical PNGs.
 */

import { PNG } from 'pngjs';

const FIXTURE_SIZE = 1024;
const BG_COLOR: readonly [number, number, number] = [255, 0, 255]; // magenta — easy to corner-remove

interface RgbaPlane {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

function makeBackground(width: number, height: number): RgbaPlane {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = BG_COLOR[0];
    data[i * 4 + 1] = BG_COLOR[1];
    data[i * 4 + 2] = BG_COLOR[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function paint(image: RgbaPlane, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
  const idx = (y * image.width + x) * 4;
  image.data[idx] = r;
  image.data[idx + 1] = g;
  image.data[idx + 2] = b;
  image.data[idx + 3] = 255;
}

function fillRect(
  image: RgbaPlane,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      paint(image, x, y, r, g, b);
    }
  }
}

function fillThickDiagonalLine(
  image: RgbaPlane,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  r: number,
  g: number,
  b: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const half = Math.floor(thickness / 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(x0 + dx * t);
    const cy = Math.round(y0 + dy * t);
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        paint(image, cx + ox, cy + oy, r, g, b);
      }
    }
  }
}

function encode(image: RgbaPlane): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

/**
 * "Good" weapon: a thick diagonal blade silhouette covering the center of the
 * frame. Carefully sized so that, after 32x downscale + palette quantize:
 *   - The output anchor at (16, 16) samples source (528, 528) which lies on
 *     the blade and is therefore opaque. (Nearest-neighbor formula:
 *     floor((dst + 0.5) * 1024 / 32) = dst*32 + 16.)
 *   - The opaque ratio sits comfortably inside [0.10, 0.65].
 *   - The PCA principal axis is well off-axis (the blade is roughly 45°).
 */
export function buildGoodSwordFixture(): Buffer {
  const img = makeBackground(FIXTURE_SIZE, FIXTURE_SIZE);
  // Diagonal blade: bottom-left to top-right, thick enough that the center
  // sample is on the line.
  fillThickDiagonalLine(img, 180, 820, 840, 180, 160, 192, 192, 200);
  return encode(img);
}

/** Empty fixture — no sprite, just background. After bg removal nothing is opaque. */
export function buildEmptyFixture(): Buffer {
  return encode(makeBackground(FIXTURE_SIZE, FIXTURE_SIZE));
}

/**
 * Horizontal-bar fixture — a single thick horizontal stripe centered. Should
 * fail the weapon silhouette-diagonal-axis sensor.
 */
export function buildHorizontalBarFixture(): Buffer {
  const img = makeBackground(FIXTURE_SIZE, FIXTURE_SIZE);
  fillRect(img, 100, 480, 900, 543, 192, 192, 200);
  return encode(img);
}

/**
 * Solid block fixture — opaque ratio after bg-removal stays near 100%, well
 * outside [0.10, 0.65]. Should fail the opaque-ratio sensor.
 */
export function buildSolidBlockFixture(): Buffer {
  const img = makeBackground(FIXTURE_SIZE, FIXTURE_SIZE);
  // A 900x900 block of body color in the middle. Corner pixels are still
  // magenta so bg removal works, but the resulting opaque ratio is huge.
  fillRect(img, 60, 60, 960, 960, 192, 192, 200);
  return encode(img);
}

/**
 * Tiny-dot fixture — a single 8x8 cluster in the center. After 32x downscale
 * the cluster is too small to satisfy the minimum opaque ratio.
 */
export function buildTinyDotFixture(): Buffer {
  const img = makeBackground(FIXTURE_SIZE, FIXTURE_SIZE);
  fillRect(img, 508, 508, 515, 515, 192, 192, 200);
  return encode(img);
}
