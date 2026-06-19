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

    it('clears connected near-background corridors deeper than one pixel (leg-gap case)', () => {
      const img = blank(8, 8, [255, 0, 255]);
      // Build top/bottom "legs" so the middle row behaves like a narrow tunnel.
      for (let x = 1; x <= 5; x++) {
        setPixel(img, x, 3, 0, 180, 40);
        setPixel(img, x, 5, 0, 180, 40);
      }
      // Close the right side so only the leftmost cell touches already-transparent bg.
      setPixel(img, 5, 4, 0, 180, 40);
      // Near-magenta corridor: outside flood-fill tolerance, inside fringe tolerance.
      for (let x = 1; x <= 4; x++) {
        setPixel(img, x, 4, 230, 20, 230);
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 8000 });
      expect(alphaAt(out, 1, 4)).toBe(0);
      expect(alphaAt(out, 2, 4)).toBe(0);
      expect(alphaAt(out, 3, 4)).toBe(0);
      expect(alphaAt(out, 4, 4)).toBe(0);
      expect(alphaAt(out, 5, 4)).toBe(255);
    });

    it('default fringe tolerance clears edge-connected remnants that block leg-gap cleanup', () => {
      const img = blank(10, 10, [255, 0, 255]);
      // Foreground rails create a narrow corridor lane at y=4.
      for (let x = 2; x <= 8; x++) {
        setPixel(img, x, 3, 0, 180, 40);
        setPixel(img, x, 5, 0, 180, 40);
      }
      // Slightly-dark magenta remnant chain (dist^2=8100 to pure magenta),
      // including an edge-touching seed at x=0 that old defaults missed.
      for (let x = 0; x <= 7; x++) {
        setPixel(img, x, 4, 255, 90, 255);
      }
      // Foreground stopper to ensure we only clear the corridor.
      setPixel(img, 8, 4, 0, 180, 40);

      const out = removeBackgroundB(img, { colorToleranceSq: 1024 });
      expect(alphaAt(out, 0, 4)).toBe(0);
      expect(alphaAt(out, 3, 4)).toBe(0);
      expect(alphaAt(out, 7, 4)).toBe(0);
      expect(alphaAt(out, 8, 4)).toBe(255);
    });

    it('center-seeded region cleanup clears wide edge-connected pockets beyond fringe tolerance', () => {
      const img = blank(96, 96, [255, 0, 255]);
      // Foreground "legs" around y=40..47 lane with one narrow edge connection.
      for (let x = 2; x <= 80; x++) {
        setPixel(img, x, 39, 0, 180, 40);
        setPixel(img, x, 48, 0, 180, 40);
      }
      // 64x8 remnant blob (512 px) connected to edge at x=0.
      // dist^2 to magenta = 14,400 (> 12,000 fringe; < 40,000 center-seed tolerance).
      for (let y = 40; y <= 47; y++) {
        for (let x = 0; x <= 63; x++) {
          setPixel(img, x, y, 255, 120, 255);
        }
      }
      setPixel(img, 64, 44, 0, 180, 40); // stopper

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 12000 });
      expect(alphaAt(out, 0, 44)).toBe(0);
      expect(alphaAt(out, 32, 44)).toBe(0);
      expect(alphaAt(out, 63, 44)).toBe(0);
      expect(alphaAt(out, 64, 44)).toBe(255);
    });

    it('clears enclosed near-background islands disconnected from edges', () => {
      const img = blank(9, 9, [255, 0, 255]);
      // Foreground ring that seals an inner cavity.
      for (let x = 2; x <= 6; x++) {
        setPixel(img, x, 2, 0, 180, 40);
        setPixel(img, x, 6, 0, 180, 40);
      }
      for (let y = 2; y <= 6; y++) {
        setPixel(img, 2, y, 0, 180, 40);
        setPixel(img, 6, y, 0, 180, 40);
      }
      // Inner cavity is near-background but not 4-connected to any edge.
      for (let y = 3; y <= 5; y++) {
        for (let x = 3; x <= 5; x++) {
          setPixel(img, x, y, 235, 18, 235);
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 8000 });
      expect(alphaAt(out, 4, 4)).toBe(0);
      expect(alphaAt(out, 3, 3)).toBe(0);
      expect(alphaAt(out, 2, 2)).toBe(255);
      expect(alphaAt(out, 6, 6)).toBe(255);
    });

    it('clears darker enclosed magenta pockets that exceed fringe tolerance', () => {
      const img = blank(9, 9, [255, 0, 255]);
      for (let x = 2; x <= 6; x++) {
        setPixel(img, x, 2, 0, 180, 40);
        setPixel(img, x, 6, 0, 180, 40);
      }
      for (let y = 2; y <= 6; y++) {
        setPixel(img, 2, y, 0, 180, 40);
        setPixel(img, 6, y, 0, 180, 40);
      }
      // Near-magenta pocket: (240, 15, 240) has squared distance (15²+15²+15²)=675 from
      // magenta — well within 8000 fringe tolerance but enclosed by foreground pixels.
      for (let y = 3; y <= 5; y++) {
        for (let x = 3; x <= 5; x++) {
          setPixel(img, x, y, 240, 15, 240);
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 8000 });
      expect(alphaAt(out, 4, 4)).toBe(0);
      expect(alphaAt(out, 3, 5)).toBe(0);
      expect(alphaAt(out, 2, 2)).toBe(255);
    });

    it('keeps enclosed interior colors that are far from background', () => {
      const img = blank(9, 9, [255, 0, 255]);
      for (let x = 2; x <= 6; x++) {
        setPixel(img, x, 2, 0, 180, 40);
        setPixel(img, x, 6, 0, 180, 40);
      }
      for (let y = 2; y <= 6; y++) {
        setPixel(img, 2, y, 0, 180, 40);
        setPixel(img, 6, y, 0, 180, 40);
      }
      for (let y = 3; y <= 5; y++) {
        for (let x = 3; x <= 5; x++) {
          setPixel(img, x, y, 200, 30, 20);
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 8000 });
      expect(alphaAt(out, 4, 4)).toBe(255);
      expect(alphaAt(out, 3, 3)).toBe(255);
    });

    it('clears medium enclosed background-like regions by center-seeded fill', () => {
      const img = blank(32, 32, [255, 0, 255]);
      // Foreground frame around an 18x18 cavity (324 px).
      for (let x = 6; x <= 25; x++) {
        setPixel(img, x, 6, 0, 180, 40);
        setPixel(img, x, 25, 0, 180, 40);
      }
      for (let y = 6; y <= 25; y++) {
        setPixel(img, 6, y, 0, 180, 40);
        setPixel(img, 25, y, 0, 180, 40);
      }
      // Background-like but beyond legacy enclosed threshold in places.
      for (let y = 7; y <= 24; y++) {
        for (let x = 7; x <= 24; x++) {
          setPixel(img, x, y, 255, 170, 255); // dist^2 to magenta = 28900
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 12000 });
      expect(alphaAt(out, 16, 16)).toBe(0);
      expect(alphaAt(out, 10, 20)).toBe(0);
      expect(alphaAt(out, 6, 6)).toBe(255);
      expect(alphaAt(out, 25, 25)).toBe(255);
    });

    it('keeps large enclosed near-background regions to avoid over-clearing foreground interiors', () => {
      const img = blank(40, 40, [255, 0, 255]);
      // Foreground frame that creates a large enclosed cavity.
      for (let x = 5; x <= 34; x++) {
        setPixel(img, x, 5, 0, 180, 40);
        setPixel(img, x, 34, 0, 180, 40);
      }
      for (let y = 5; y <= 34; y++) {
        setPixel(img, 5, y, 0, 180, 40);
        setPixel(img, 34, y, 0, 180, 40);
      }
      // 20x20 enclosed near-background region (400 px) is intentionally
      // larger than the enclosed-island cap and must be preserved.
      for (let y = 10; y <= 29; y++) {
        for (let x = 10; x <= 29; x++) {
          setPixel(img, x, y, 240, 15, 240);
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 8000 });
      expect(alphaAt(out, 20, 20)).toBe(255);
      expect(alphaAt(out, 10, 10)).toBe(255);
    });

    it('clears a small enclosed residual pocket slightly beyond fringe tolerance', () => {
      const img = blank(11, 11, [255, 0, 255]);
      // Isolated 3x3 pocket with shades that are just beyond the default
      // fringe threshold. The flood + near-color enclosed pass won't remove
      // it, but residual enclosed cleanup should.
      for (let y = 4; y <= 6; y++) {
        for (let x = 4; x <= 6; x++) {
          setPixel(img, x, y, 255, 95, 255); // dist^2 to magenta = 9025
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 8000 });
      expect(alphaAt(out, 5, 5)).toBe(0);
      expect(alphaAt(out, 6, 6)).toBe(0);
    });

    it('preserves enclosed details when near-background seed coverage is too sparse', () => {
      const img = blank(16, 16, [255, 0, 255]);
      for (let x = 2; x <= 13; x++) {
        setPixel(img, x, 2, 0, 180, 40);
        setPixel(img, x, 13, 0, 180, 40);
      }
      for (let y = 2; y <= 13; y++) {
        setPixel(img, 2, y, 0, 180, 40);
        setPixel(img, 13, y, 0, 180, 40);
      }
      // 10x10 enclosed detail region (100 px) with only one near-bg seed pixel.
      for (let y = 3; y <= 12; y++) {
        for (let x = 3; x <= 12; x++) {
          setPixel(img, x, y, 170, 110, 80);
        }
      }
      setPixel(img, 8, 8, 255, 90, 255); // single near-background seed

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 8000 });
      expect(alphaAt(out, 8, 8)).toBe(255);
      expect(alphaAt(out, 6, 6)).toBe(255);
    });

    it('clears lower-half magenta-family artifacts on magenta backgrounds', () => {
      const img = blank(32, 32, [255, 0, 255]);
      // Mid-body foreground rails.
      for (let x = 3; x <= 24; x++) {
        setPixel(img, x, 14, 0, 180, 40);
        setPixel(img, x, 20, 0, 180, 40);
      }
      // Artifact blob under the body; color is magenta-family but farther than center seed tolerance.
      for (let y = 15; y <= 19; y++) {
        for (let x = 4; x <= 20; x++) {
          setPixel(img, x, y, 140, 120, 140); // dist^2 to magenta = 41,425
        }
      }
      setPixel(img, 21, 17, 0, 180, 40); // stopper

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 12000 });
      expect(alphaAt(out, 10, 17)).toBe(0);
      expect(alphaAt(out, 20, 17)).toBe(0);
      expect(alphaAt(out, 21, 17)).toBe(255);
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
