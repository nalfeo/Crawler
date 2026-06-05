/**
 * Unit tests for the pure `deriveAnchor` algorithm. Each test constructs a
 * tiny 16x16 RgbaImage by hand so the algorithm's behavior is unambiguous
 * and reviewers don't need to inspect fixture PNGs.
 *
 * The algorithm contract is documented in
 * `scripts/sprites/sensors/derive-anchor.ts`. These tests pin the
 * behaviorally-significant branches and the default values.
 */

import { describe, expect, it } from 'vitest';
import {
  DERIVE_ANCHOR_DEFAULTS,
  deriveAnchor,
} from '../../../scripts/sprites/sensors/derive-anchor.js';
import type { RgbaImage } from '../../../scripts/sprites/sensors/common.js';

function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => boolean,
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = 128;
      data[idx + 1] = 128;
      data[idx + 2] = 128;
      data[idx + 3] = paint(x, y) ? 255 : 0;
    }
  }
  return { width, height, data };
}

describe('deriveAnchor', () => {
  it('returns the bottom-center pixel for a single centered haft', () => {
    // Vertical haft 2 pixels wide centered on x=7..8, reaching the bottom row.
    const img = makeImage(16, 16, (x, y) => (x === 7 || x === 8) && y >= 8);
    const result = deriveAnchor(img);
    // Bottom row y=15 has an opaque run [7, 8] -> midpoint floor((7+8)/2) = 7,
    // which is exactly floor(16/2) - 1 = 7 (within ±3 of center 8).
    expect(result.reason).toBeNull();
    expect(result.anchor).toEqual({ x: 7, y: 15 });
  });

  it('on a row with multiple opaque runs, picks the one closest to center', () => {
    // Three runs on the bottom row: far-left [0,1], center [7,8], far-right [14,15].
    const img = makeImage(16, 16, (x, y) => y === 15 && (x <= 1 || x === 7 || x === 8 || x >= 14));
    const result = deriveAnchor(img);
    expect(result.anchor).toEqual({ x: 7, y: 15 });
    expect(result.reason).toBeNull();
  });

  it('returns null when no opaque pixel sits in the bottom bandRows', () => {
    // Subject floats: only opaque pixels at y=0..3, nothing in y=12..15.
    const img = makeImage(16, 16, (x, y) => y < 4 && x >= 6 && x <= 9);
    const result = deriveAnchor(img);
    expect(result.anchor).toBeNull();
    expect(result.reason).toMatch(/no opaque pixel in bottom 4 rows/);
  });

  it('returns null when the grip midpoint is outside centerToleranceX', () => {
    // Hard-left grip: opaque run at x=0..1 on bottom row. Midpoint 0,
    // center 8, |0-8| = 8 > default tolerance 3.
    const img = makeImage(16, 16, (x, y) => y === 15 && x <= 1);
    const result = deriveAnchor(img);
    expect(result.anchor).toBeNull();
    expect(result.reason).toMatch(/grip midpoint x=0 is outside ±3 of center 8/);
  });

  it('returns null with a stable reason on an all-transparent image', () => {
    const img = makeImage(16, 16, () => false);
    const result = deriveAnchor(img);
    expect(result.anchor).toBeNull();
    expect(result.reason).toMatch(/no opaque pixels in image/);
  });

  it('honors a custom bandRows that accepts a higher grip row', () => {
    // Grip on y=10 only (bottom 6 rows). Default bandRows=4 would reject; 6 should accept.
    const img = makeImage(16, 16, (x, y) => y === 10 && (x === 7 || x === 8));
    expect(deriveAnchor(img).anchor).toBeNull();
    const result = deriveAnchor(img, { bandRows: 6 });
    expect(result.anchor).toEqual({ x: 7, y: 10 });
    expect(result.reason).toBeNull();
  });

  it('honors a custom centerToleranceX that accepts a more off-center grip', () => {
    // Grip midpoint at x=4 (|4-8|=4). Default tolerance 3 -> null; tolerance 5 -> ok.
    const img = makeImage(16, 16, (x, y) => y === 15 && x >= 3 && x <= 5);
    expect(deriveAnchor(img).anchor).toBeNull();
    const result = deriveAnchor(img, { centerToleranceX: 5 });
    expect(result.anchor).toEqual({ x: 4, y: 15 });
  });

  it('refuses to derive on a zero-dimension image', () => {
    const img: RgbaImage = { width: 0, height: 0, data: new Uint8Array(0) };
    const result = deriveAnchor(img);
    expect(result.anchor).toBeNull();
    expect(result.reason).toMatch(/zero pixels/);
  });

  it('exposes the defaults via a frozen constant', () => {
    expect(DERIVE_ANCHOR_DEFAULTS).toEqual({ bandRows: 4, centerToleranceX: 3 });
    expect(Object.isFrozen(DERIVE_ANCHOR_DEFAULTS)).toBe(true);
  });
});
