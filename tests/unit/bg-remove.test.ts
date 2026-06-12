import { describe, it, expect } from 'vitest';
import {
  removeBackground,
  removeBackgroundB,
  type RgbaImage,
} from '../../scripts/sprites/postprocess.js';

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

  describe('removeBackgroundB', () => {
    it('removes near-background edge fringe left by legacy flood fill', () => {
      const img = blank(8, 8, [255, 0, 255]);
      // Near-magenta pixel outside legacy tolerance (32) but inside B fringe tolerance.
      setPixel(img, 1, 4, 230, 20, 230);
      const legacy = removeBackground(img);
      expect(alphaAt(legacy, 1, 4)).toBe(255);
      const out = removeBackgroundB(img);
      expect(alphaAt(out, 1, 4)).toBe(0);
    });

    it('keeps edge-adjacent foreground colors that are far from corner background colors', () => {
      const img = blank(8, 8, [255, 0, 255]);
      setPixel(img, 1, 4, 0, 180, 40);
      const out = removeBackgroundB(img);
      expect(alphaAt(out, 1, 4)).toBe(255);
    });
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

  // ── Tolerance behaviour (BACKGROUND_COLOR_TOLERANCE_SQ) ────────────────
  // Real provider PNGs rarely have a perfectly flat background colour —
  // gpt-image-1 returns near-white with ±1-12 per-channel noise around the
  // corners. The flood fill uses squared-Euclidean RGB tolerance so these
  // are still treated as background.

  it('floods near-white pixels that differ from the corner by small per-channel noise', () => {
    // Corner is pure white; body has ±5 noise per channel — well within the
    // ~32-channel tolerance and so should be flooded transparent.
    const img = blank(8, 8, [255, 255, 255]);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        setPixel(img, x, y, 252, 250, 254);
      }
    }
    setPixel(img, 0, 0, 255, 255, 255); // pure-white corner anchor
    const out = removeBackground(img);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(alphaAt(out, x, y)).toBe(0);
      }
    }
  });

  it('does not eat a saturated foreground colour that lives well outside tolerance', () => {
    // Background near-white (250,250,250); a single bright-red pixel in
    // the centre (255,0,0). Squared Euclidean RGB distance is
    // 5² + 250² + 250² = 125025 — over 100× the 32² = 1024 tolerance —
    // so flood-fill must never reach the red pixel.
    const img = blank(8, 8, [250, 250, 250]);
    setPixel(img, 4, 4, 255, 0, 0);
    const out = removeBackground(img);
    expect(alphaAt(out, 4, 4)).toBe(255);
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 7, 7)).toBe(0);
  });

  it('preserves a bone-white foreground when it has at least a 1-pixel margin from the edge', () => {
    // Background is dark grey; the foreground is bone-white. With a 1-pixel
    // dark margin on every edge, the flood fill never reaches the bone
    // region even though bone is within tolerance of pure white. This is
    // the realistic case for a skull-mace sprite on a dark canvas.
    const img = blank(8, 8, [40, 40, 40]);
    for (let y = 2; y <= 5; y++) {
      for (let x = 2; x <= 5; x++) {
        setPixel(img, x, y, 245, 245, 240); // bone-white
      }
    }
    const out = removeBackground(img);
    for (let y = 2; y <= 5; y++) {
      for (let x = 2; x <= 5; x++) {
        expect(alphaAt(out, x, y)).toBe(255);
      }
    }
    // Dark border still goes transparent.
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 7, 7)).toBe(0);
  });

  it('still eats foreground that touches the edge and is within tolerance of the corner colour (known limitation)', () => {
    // Documented edge case: if a near-background-coloured foreground pixel
    // is 4-connected to a corner, the flood reaches it. This is the
    // intentional behaviour — sprites are composed centred with margin
    // (see briefs' "single subject centered" rule), and asking the flood
    // fill to second-guess that is a bigger problem than it solves.
    const img = blank(8, 8, [255, 255, 255]);
    // Bone-white foreground that runs to the top edge.
    setPixel(img, 4, 0, 245, 245, 240);
    setPixel(img, 4, 1, 245, 245, 240);
    setPixel(img, 4, 2, 245, 245, 240);
    const out = removeBackground(img);
    expect(alphaAt(out, 4, 0)).toBe(0);
    expect(alphaAt(out, 4, 1)).toBe(0);
    expect(alphaAt(out, 4, 2)).toBe(0);
  });
});
