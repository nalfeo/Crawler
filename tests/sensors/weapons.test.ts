/**
 * Weapon-specific sensors.
 *
 * Universal sensors live in `./common.ts`; this file adds checks that only
 * apply to the `weapon` sprite type. Each sensor is unit-testable in
 * isolation by constructing a small RgbaImage by hand.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeSprite,
  gatherOpaquePixels,
  principalAxisAngleRadians,
  type Pixel,
  type RgbaImage,
  type SensorResult,
} from './common.js';
import { PNG } from 'pngjs';

const RAD_PER_DEG = Math.PI / 180;
const DIAGONAL_TOLERANCE_RAD = 2 * RAD_PER_DEG;

/**
 * Check that the silhouette has at least one diagonal axis of variation: the
 * principal axis (largest eigenvector of the opaque-pixel covariance) must
 * not be within ±2° of horizontal or vertical.
 *
 * Why: weapons that come out as perfectly axis-aligned blobs read as items,
 * not weapons. Forcing diagonal variance catches "pile of pixels" failures
 * that pass every universal sensor.
 */
export function silhouetteDiagonalAxis(image: RgbaImage): SensorResult {
  const sensor = 'silhouette-diagonal-axis';
  const opaque = gatherOpaquePixels(image);
  if (opaque.length === 0) {
    return { ok: false, sensor, reason: 'no opaque pixels' };
  }
  const angle = principalAxisAngleRadians(opaque);
  if (angle === null) {
    return { ok: false, sensor, reason: 'principal axis undefined (degenerate point cloud)' };
  }
  const halfPi = Math.PI / 2;
  const distFromHorizontal = Math.min(
    Math.abs(angle),
    Math.abs(angle - Math.PI),
    Math.abs(angle + Math.PI),
  );
  const distFromVertical = Math.min(Math.abs(angle - halfPi), Math.abs(angle + halfPi));
  if (distFromHorizontal < DIAGONAL_TOLERANCE_RAD) {
    return {
      ok: false,
      sensor,
      reason: `principal axis ${(angle / RAD_PER_DEG).toFixed(2)}° is within ±2° of horizontal`,
    };
  }
  if (distFromVertical < DIAGONAL_TOLERANCE_RAD) {
    return {
      ok: false,
      sensor,
      reason: `principal axis ${(angle / RAD_PER_DEG).toFixed(2)}° is within ±2° of vertical`,
    };
  }
  return { ok: true, sensor };
}

export function weaponSensors(image: RgbaImage): SensorResult[] {
  return [silhouetteDiagonalAxis(image)];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => boolean,
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const opaque = paint(x, y);
      data[idx] = 200;
      data[idx + 1] = 100;
      data[idx + 2] = 50;
      data[idx + 3] = opaque ? 255 : 0;
    }
  }
  return { width, height, data };
}

describe('silhouetteDiagonalAxis', () => {
  it('passes a 45° diagonal line', () => {
    const img = makeImage(32, 32, (x, y) => x === y);
    expect(silhouetteDiagonalAxis(img)).toEqual({ ok: true, sensor: 'silhouette-diagonal-axis' });
  });

  it('passes a 30° diagonal line', () => {
    // y = round(x * tan(30°)); place opaque pixels along that line.
    const img = makeImage(64, 64, (x, y) => Math.round(x * Math.tan(30 * RAD_PER_DEG)) === y);
    const result = silhouetteDiagonalAxis(img);
    expect(result.ok).toBe(true);
  });

  it('fails a strictly horizontal line', () => {
    const img = makeImage(32, 32, (x, y) => y === 16 && x >= 4 && x <= 28);
    const result = silhouetteDiagonalAxis(img);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('horizontal');
    }
  });

  it('fails a strictly vertical line', () => {
    const img = makeImage(32, 32, (x, y) => x === 16 && y >= 4 && y <= 28);
    const result = silhouetteDiagonalAxis(img);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('vertical');
    }
  });

  it('fails a 1°-off-horizontal line as horizontal (within tolerance)', () => {
    // Slope of tan(1°) is about 0.0175; over 64 px the line spans ~1 px in y.
    const img = makeImage(64, 32, (x, y) => Math.round(x * Math.tan(1 * RAD_PER_DEG)) === y - 8);
    const result = silhouetteDiagonalAxis(img);
    expect(result.ok).toBe(false);
  });

  it('passes a 5°-off-horizontal line', () => {
    const img = makeImage(64, 64, (x, y) => Math.round(x * Math.tan(5 * RAD_PER_DEG)) === y - 8);
    const result = silhouetteDiagonalAxis(img);
    expect(result.ok).toBe(true);
  });

  it('fails when there are no opaque pixels', () => {
    const img = makeImage(8, 8, () => false);
    const result = silhouetteDiagonalAxis(img);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no opaque pixels');
    }
  });

  it('fails on a single opaque pixel (degenerate cloud)', () => {
    const img = makeImage(8, 8, (x, y) => x === 3 && y === 3);
    const result = silhouetteDiagonalAxis(img);
    expect(result.ok).toBe(false);
  });
});

describe('decodeSprite', () => {
  it('round-trips a checkerboard pattern through PNG', () => {
    const png = new PNG({ width: 4, height: 4 });
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const idx = (y * 4 + x) * 4;
        const opaque = (x + y) % 2 === 0;
        png.data[idx] = 10;
        png.data[idx + 1] = 20;
        png.data[idx + 2] = 30;
        png.data[idx + 3] = opaque ? 255 : 0;
      }
    }
    const buffer = PNG.sync.write(png);
    const decoded = decodeSprite(buffer);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    const opaqueCount = (gatherOpaquePixels(decoded) as Pixel[]).length;
    expect(opaqueCount).toBe(8);
  });
});
