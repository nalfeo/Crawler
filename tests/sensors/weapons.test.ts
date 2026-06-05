/**
 * Unit tests for weapon-specific sensors. The sensor *implementation* lives
 * in `./weapons.ts` so it can be imported by integration tests without
 * pulling in this file's `describe`/`it` blocks.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeSprite,
  gatherOpaquePixels,
  type Pixel,
  type RgbaImage,
} from '../../scripts/sprites/sensors/common.js';
import { silhouetteDiagonalAxis, RAD_PER_DEG } from '../../scripts/sprites/sensors/weapons.js';
import { PNG } from 'pngjs';

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
