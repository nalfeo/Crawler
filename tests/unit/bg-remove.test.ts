import { describe, it, expect } from 'vitest';
import { removeBackground, type RgbaImage } from '../../scripts/sprites/postprocess.js';

function blank(width: number, height: number, color: readonly [number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function setPixel(
  image: RgbaImage,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): void {
  const idx = (y * image.width + x) * 4;
  image.data[idx] = r;
  image.data[idx + 1] = g;
  image.data[idx + 2] = b;
  image.data[idx + 3] = a;
}

function alphaAt(image: RgbaImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3] ?? 0;
}

describe('removeBackground', () => {
  it('marks the entire image transparent when it is one solid color', () => {
    const img = blank(8, 8, [128, 128, 128]);
    const out = removeBackground(img);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(alphaAt(out, x, y)).toBe(0);
      }
    }
  });

  it('leaves an interior region of a different color fully opaque', () => {
    const img = blank(8, 8, [200, 200, 200]); // background gray
    // Paint a 4x4 red region in the middle (rows 2..5, cols 2..5).
    for (let y = 2; y <= 5; y++) {
      for (let x = 2; x <= 5; x++) {
        setPixel(img, x, y, 255, 0, 0);
      }
    }
    const out = removeBackground(img);
    // The whole 4x4 red region is opaque...
    for (let y = 2; y <= 5; y++) {
      for (let x = 2; x <= 5; x++) {
        expect(alphaAt(out, x, y)).toBe(255);
      }
    }
    // ...and the gray background ring is transparent.
    for (let x = 0; x < 8; x++) {
      expect(alphaAt(out, x, 0)).toBe(0);
      expect(alphaAt(out, x, 7)).toBe(0);
    }
    for (let y = 0; y < 8; y++) {
      expect(alphaAt(out, 0, y)).toBe(0);
      expect(alphaAt(out, 7, y)).toBe(0);
    }
  });

  it('preserves disconnected pixels of the corner color (interior holes are not flooded)', () => {
    // Background is gray; an isolated gray pixel inside a red region must
    // stay opaque because the flood fill only reaches connected pixels.
    const img = blank(8, 8, [200, 200, 200]); // bg gray
    // Paint rows 1..6, cols 1..6 red...
    for (let y = 1; y <= 6; y++) {
      for (let x = 1; x <= 6; x++) {
        setPixel(img, x, y, 255, 0, 0);
      }
    }
    // ...with a single gray hole at (4, 4).
    setPixel(img, 4, 4, 200, 200, 200);
    const out = removeBackground(img);
    // The isolated interior gray pixel stays opaque.
    expect(alphaAt(out, 4, 4)).toBe(255);
    // The connected gray border is transparent.
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 7, 7)).toBe(0);
  });

  it('uses 4-connectivity (does not leak through diagonal-only paths)', () => {
    // Build an image where the only "gap" between two gray regions is a
    // diagonal touch. With 4-connectivity, the inner gray must NOT be
    // flooded.
    const img = blank(5, 5, [255, 0, 0]); // bg red
    // Paint a frame of gray on the corners + diagonals only.
    setPixel(img, 0, 0, 200, 200, 200); // corner
    setPixel(img, 1, 1, 200, 200, 200); // diagonal neighbor
    setPixel(img, 2, 2, 200, 200, 200); // center, only diagonally connected
    const out = removeBackground(img);
    // (0,0) is the corner color but isn't gray — it IS gray here. So flood
    // starts from (0,0). 4-connectivity means (1,1) is not reached because
    // it's a diagonal step. Verify (1,1) and (2,2) stay opaque.
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 1, 1)).toBe(255);
    expect(alphaAt(out, 2, 2)).toBe(255);
  });

  it('runs from all 4 corners independently', () => {
    // Different corner colors; each should flood its own connected region.
    const img = blank(6, 6, [50, 50, 50]); // body color
    setPixel(img, 0, 0, 255, 0, 0); // top-left red
    setPixel(img, 5, 0, 0, 255, 0); // top-right green
    setPixel(img, 0, 5, 0, 0, 255); // bottom-left blue
    setPixel(img, 5, 5, 255, 255, 0); // bottom-right yellow
    const out = removeBackground(img);
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 5, 0)).toBe(0);
    expect(alphaAt(out, 0, 5)).toBe(0);
    expect(alphaAt(out, 5, 5)).toBe(0);
    // The body color is untouched (no corner has that color).
    expect(alphaAt(out, 3, 3)).toBe(255);
  });

  it('is idempotent on an already-transparent corner', () => {
    const img = blank(4, 4, [200, 200, 200]);
    setPixel(img, 0, 0, 0, 0, 0, 0); // already transparent corner
    const out = removeBackground(img);
    expect(alphaAt(out, 0, 0)).toBe(0);
  });
});
