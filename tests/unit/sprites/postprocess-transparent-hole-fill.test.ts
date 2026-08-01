/**
 * Unit tests for `fillEnclosedTransparentHoles` — the post-alpha-threshold
 * module that fills transparent (alpha=0) pixels that are completely surrounded
 * by opaque pixels (not reachable from any border by a 4-connected transparent
 * path).
 *
 * Unlike the background-region cleanup tests, these fixtures use transparent
 * pixels (alpha=0) as holes — no "background colour" is involved.
 */
import { describe, expect, it } from 'vitest';
import { fillEnclosedTransparentHoles } from '../../../scripts/sprites/postprocess.js';
import type { RgbaImage } from '../../../scripts/sprites/postprocess.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a square RgbaImage from a 2-D array of [r, g, b, a] tuples. */
function makeImage(
  pixels: ReadonlyArray<ReadonlyArray<readonly [number, number, number, number]>>,
): RgbaImage {
  const height = pixels.length;
  const width = pixels[0]?.length ?? 0;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixels[y]![x]!;
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

/** Read a pixel from an RgbaImage as [r, g, b, a]. */
function getPixel(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

// Shorthand RGBA tuples for test fixtures.
const O: readonly [number, number, number, number] = [200, 100, 50, 255]; // opaque orange
const T: readonly [number, number, number, number] = [0, 0, 0, 0]; // transparent

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('fillEnclosedTransparentHoles', () => {
  it('fills a single interior transparent pixel in a 3×3 opaque ring', () => {
    // 3×3: all opaque except the exact centre — the centre is enclosed.
    const img = makeImage([
      [O, O, O],
      [O, T, O],
      [O, O, O],
    ]);
    const out = fillEnclosedTransparentHoles(img);
    const [, , , a] = getPixel(out, 1, 1);
    expect(a).toBe(255); // was transparent — must now be opaque
  });

  it('fills colour as average of opaque 4-neighbours', () => {
    // Centre surrounded by four distinct colours — result should be average.
    const R: readonly [number, number, number, number] = [200, 0, 0, 255];
    const Gb: readonly [number, number, number, number] = [0, 200, 0, 255];
    const B: readonly [number, number, number, number] = [0, 0, 200, 255];
    const W: readonly [number, number, number, number] = [200, 200, 200, 255];
    // 3×3 with opaque corners (diagonal — not 4-connected to centre).
    // Use a 3×3 where only the 4-connected neighbours are distinct colours.
    const img = makeImage([
      [O, R, O],
      [Gb, T, B],
      [O, W, O],
    ]);
    const out = fillEnclosedTransparentHoles(img);
    const [r, g, b, a] = getPixel(out, 1, 1);
    expect(a).toBe(255);
    // Average of R(200,0,0), Gb(0,200,0), B(0,0,200), W(200,200,200) = (100,100,100)
    expect(r).toBe(100);
    expect(g).toBe(100);
    expect(b).toBe(100);
  });

  it('does NOT fill a transparent pixel that touches the border', () => {
    // 3×3: top-left corner is transparent — it is on the border → exterior.
    const img = makeImage([
      [T, O, O],
      [O, O, O],
      [O, O, O],
    ]);
    const out = fillEnclosedTransparentHoles(img);
    const [, , , a] = getPixel(out, 0, 0);
    expect(a).toBe(0); // must remain transparent
  });

  it('does NOT fill transparent pixels connected to the border via a transparent path', () => {
    // 5×5: transparent pixel at (2,2) but connected to the left edge via (2,0).
    const X: readonly [number, number, number, number] = [255, 255, 0, 255]; // yellow opaque
    const img = makeImage([
      [T, T, T, T, T], // top row — all transparent (border-connected)
      [X, X, X, X, X],
      [T, T, T, X, X], // (2,2) connected to (2,0) via (2,1)? No — (2,1)=X, so use row 0 path
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    // (0,0),(1,0),(2,0) are border-transparent; (0,2),(1,2),(2,2) are also
    // transparent but NOT directly connected — they are surrounded by opaque
    // rows 1 and 3, and left edge. (0,2) touches left border → exterior.
    const out = fillEnclosedTransparentHoles(img);
    // (0,2) is on left border → exterior
    const [, , , a02] = getPixel(out, 0, 2);
    expect(a02).toBe(0);
    // (1,2) and (2,2) are connected to (0,2) → also exterior
    const [, , , a12] = getPixel(out, 1, 2);
    expect(a12).toBe(0);
    const [, , , a22] = getPixel(out, 2, 2);
    expect(a22).toBe(0);
  });

  it('fills a ring interior hole — transparent center inside opaque ring', () => {
    // 5×5: opaque ring border with transparent 3×3 interior, except corners are
    // opaque too. The interior is 100% enclosed.
    const img = makeImage([
      [O, O, O, O, O],
      [O, T, T, T, O],
      [O, T, T, T, O],
      [O, T, T, T, O],
      [O, O, O, O, O],
    ]);
    const out = fillEnclosedTransparentHoles(img);
    // All 9 interior pixels must be opaque now.
    for (let y = 1; y <= 3; y++) {
      for (let x = 1; x <= 3; x++) {
        const [, , , a] = getPixel(out, x, y);
        expect(a).toBe(255);
      }
    }
  });

  it('leaves an entirely transparent image unchanged', () => {
    const img = makeImage([
      [T, T, T],
      [T, T, T],
      [T, T, T],
    ]);
    const out = fillEnclosedTransparentHoles(img);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const [, , , a] = getPixel(out, x, y);
        expect(a).toBe(0); // everything is exterior
      }
    }
  });

  it('leaves an entirely opaque image unchanged', () => {
    const img = makeImage([
      [O, O, O],
      [O, O, O],
      [O, O, O],
    ]);
    const out = fillEnclosedTransparentHoles(img);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const [r, , , a] = getPixel(out, x, y);
        expect(a).toBe(255);
        expect(r).toBe(200); // original colour untouched
      }
    }
  });

  it('handles a zero-width image without throwing', () => {
    const img: RgbaImage = { width: 0, height: 0, data: new Uint8Array(0) };
    expect(() => fillEnclosedTransparentHoles(img)).not.toThrow();
  });

  it('works on a non-square image (wider than tall)', () => {
    // 1×3: middle pixel is enclosed (surrounded left/right by opaque, above/below by border)
    // Actually for 1 row, every pixel IS on the border → nothing enclosed.
    // Use 3×5: single hole in the middle row.
    const img = makeImage([
      [O, O, O, O, O],
      [O, O, T, O, O],
      [O, O, O, O, O],
    ]);
    const out = fillEnclosedTransparentHoles(img);
    const [, , , a] = getPixel(out, 2, 1);
    expect(a).toBe(255); // enclosed → filled
  });
});
