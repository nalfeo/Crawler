import { describe, expect, it } from 'vitest';
import { deriveOpaqueBounds } from '../../scripts/sprites/derive-opaque-bounds.js';

function canvas(
  w: number,
  h: number,
  opaque: (x: number, y: number) => number,
): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      data[(w * y + x) * 4 + 3] = opaque(x, y);
    }
  }
  return { width: w, height: h, data };
}

describe('deriveOpaqueBounds', () => {
  it('finds the inclusive box of visible pixels', () => {
    const png = canvas(10, 10, (x, y) => (x >= 2 && x <= 6 && y >= 3 && y <= 8 ? 255 : 0));
    expect(deriveOpaqueBounds(png)).toEqual({
      x: 2,
      y: 3,
      width: 5,
      height: 6,
      canvasWidth: 10,
      canvasHeight: 10,
    });
  });

  it('treats near-transparent pixels as transparent, matching the sensors', () => {
    // The post-processor leaves faint alpha residue at the edges; counting it
    // would make every box the full canvas and silently disable the whole fix.
    const png = canvas(10, 10, (x, y) => {
      if (x === 4 && y === 4) return 255;
      return 8;
    });
    expect(deriveOpaqueBounds(png)).toMatchObject({ x: 4, y: 4, width: 1, height: 1 });
  });

  it('counts alpha just above the threshold', () => {
    const png = canvas(10, 10, (x, y) => (x === 1 && y === 1 ? 9 : 0));
    expect(deriveOpaqueBounds(png)).toMatchObject({ x: 1, y: 1, width: 1, height: 1 });
  });

  it('returns the whole canvas for fully transparent art instead of a degenerate box', () => {
    const png = canvas(8, 6, () => 0);
    expect(deriveOpaqueBounds(png)).toEqual({
      x: 0,
      y: 0,
      width: 8,
      height: 6,
      canvasWidth: 8,
      canvasHeight: 6,
    });
  });

  it('handles art that touches every canvas edge', () => {
    const png = canvas(4, 4, () => 255);
    expect(deriveOpaqueBounds(png)).toEqual({
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      canvasWidth: 4,
      canvasHeight: 4,
    });
  });

  it('includes detached islands in the box', () => {
    const png = canvas(10, 10, (x, y) => ((x === 0 && y === 0) || (x === 9 && y === 9) ? 255 : 0));
    expect(deriveOpaqueBounds(png)).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
  });
});
