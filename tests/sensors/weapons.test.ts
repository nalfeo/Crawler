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
import { silhouetteDiagonalAxis, silhouetteOrientationAxis, RAD_PER_DEG } from '../../scripts/sprites/sensors/weapons.js';
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

describe('silhouetteDiagonalAxis (deprecated shim)', () => {
  it('passes a 45° diagonal line', () => {
    const img = makeImage(32, 32, (x, y) => x === y);
    expect(silhouetteDiagonalAxis(img)).toEqual({
      ok: true,
      sensor: 'silhouette-orientation-axis',
    });
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

describe('silhouetteOrientationAxis', () => {
  it('default orientation is vertical: passes a vertical bar', () => {
    const img = makeImage(32, 32, (x, y) => x === 16 && y >= 4 && y <= 28);
    const result = silhouetteOrientationAxis(img);
    expect(result.ok).toBe(true);
  });

  it('default orientation is vertical: fails a 45° diagonal line', () => {
    const img = makeImage(32, 32, (x, y) => x === y);
    const result = silhouetteOrientationAxis(img);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('vertical');
  });

  it('orientation "any" passes any silhouette, even horizontal', () => {
    const img = makeImage(32, 32, (x, y) => y === 16 && x >= 4 && x <= 28);
    const result = silhouetteOrientationAxis(img, { orientation: 'any' });
    expect(result).toEqual({ ok: true, sensor: 'silhouette-orientation-axis' });
  });

  it('orientation "any" still fails on an empty image (sentinel for missing data)', () => {
    const img = makeImage(8, 8, () => false);
    const result = silhouetteOrientationAxis(img, { orientation: 'any' });
    expect(result.ok).toBe(false);
  });

  it('orientation "horizontal" passes a horizontal bar and fails a vertical one', () => {
    const horiz = makeImage(32, 32, (x, y) => y === 16 && x >= 4 && x <= 28);
    const vert = makeImage(32, 32, (x, y) => x === 16 && y >= 4 && y <= 28);
    expect(silhouetteOrientationAxis(horiz, { orientation: 'horizontal' }).ok).toBe(true);
    expect(silhouetteOrientationAxis(vert, { orientation: 'horizontal' }).ok).toBe(false);
  });

  it('orientation "vertical" passes a vertical bar and fails a horizontal one', () => {
    const horiz = makeImage(32, 32, (x, y) => y === 16 && x >= 4 && x <= 28);
    const vert = makeImage(32, 32, (x, y) => x === 16 && y >= 4 && y <= 28);
    expect(silhouetteOrientationAxis(vert, { orientation: 'vertical' }).ok).toBe(true);
    expect(silhouetteOrientationAxis(horiz, { orientation: 'vertical' }).ok).toBe(false);
  });

  it('orientation "diagonal" fails both vertical and horizontal but passes 45°', () => {
    const horiz = makeImage(32, 32, (x, y) => y === 16 && x >= 4 && x <= 28);
    const vert = makeImage(32, 32, (x, y) => x === 16 && y >= 4 && y <= 28);
    const diag = makeImage(32, 32, (x, y) => x === y);
    expect(silhouetteOrientationAxis(horiz, { orientation: 'diagonal' }).ok).toBe(false);
    expect(silhouetteOrientationAxis(vert, { orientation: 'diagonal' }).ok).toBe(false);
    expect(silhouetteOrientationAxis(diag, { orientation: 'diagonal' }).ok).toBe(true);
  });

  it('respects an enlarged toleranceDeg for vertical (a slightly-off-axis vertical bar still passes)', () => {
    // Build a vertical bar with a ~3° lean. Default tolerance 2° rejects it;
    // tolerance 5° accepts it.
    const img = makeImage(32, 64, (x, y) => x === 16 + Math.round(y * Math.tan(3 * RAD_PER_DEG)));
    expect(silhouetteOrientationAxis(img, { orientation: 'vertical' }).ok).toBe(false);
    expect(
      silhouetteOrientationAxis(img, { orientation: 'vertical', toleranceDeg: 5 }).ok,
    ).toBe(true);
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
