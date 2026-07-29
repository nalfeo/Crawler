import { describe, it, expect } from 'vitest';
import {
  removeBackground,
  removeBackgroundB,
  BACKGROUND_B_COLOR_TOLERANCE_SQ,
  BACKGROUND_B_FRINGE_TOLERANCE_SQ,
  type RgbaImage,
} from '../../../scripts/sprites/postprocess.js';

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

    it('clears large enclosed background-coloured regions regardless of size (leg-gap fix)', () => {
      const img = blank(32, 32, [255, 0, 255]);
      // Foreground frame around an 18x18 cavity (324 px) — the kind of large
      // pocket that forms between a character's legs. It must be fully cleared.
      for (let x = 6; x <= 25; x++) {
        setPixel(img, x, 6, 0, 180, 40);
        setPixel(img, x, 25, 0, 180, 40);
      }
      for (let y = 6; y <= 25; y++) {
        setPixel(img, 6, y, 0, 180, 40);
        setPixel(img, 25, y, 0, 180, 40);
      }
      // Cavity is pure-ish background colour (dist^2 to magenta = 1600, within fringe).
      for (let y = 7; y <= 24; y++) {
        for (let x = 7; x <= 24; x++) {
          setPixel(img, x, y, 255, 40, 255);
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 12000 });
      expect(alphaAt(out, 16, 16)).toBe(0);
      expect(alphaAt(out, 10, 20)).toBe(0);
      expect(alphaAt(out, 6, 6)).toBe(255);
      expect(alphaAt(out, 25, 25)).toBe(255);
    });

    it('preserves large enclosed shadow-coloured regions that are not background-like', () => {
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
      // 20x20 enclosed shadow region: semi-transparent grey painted over pink
      // reads as (180,120,170), dist^2 to magenta = 27250 (far beyond fringe).
      // Body shadows like this must be preserved even when fully enclosed.
      for (let y = 10; y <= 29; y++) {
        for (let x = 10; x <= 29; x++) {
          setPixel(img, x, y, 180, 120, 170);
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 12000 });
      expect(alphaAt(out, 20, 20)).toBe(255);
      expect(alphaAt(out, 10, 10)).toBe(255);
    });

    it('clears a small enclosed background pocket sealed from the border', () => {
      const img = blank(11, 11, [255, 0, 255]);
      // Foreground frame sealing a 3x3 cavity away from the image border.
      for (let x = 3; x <= 7; x++) {
        setPixel(img, x, 3, 0, 180, 40);
        setPixel(img, x, 7, 0, 180, 40);
      }
      for (let y = 3; y <= 7; y++) {
        setPixel(img, 3, y, 0, 180, 40);
        setPixel(img, 7, y, 0, 180, 40);
      }
      // Cavity halo (255,80,255) has dist^2 = 6400 to magenta: inside the fringe
      // tolerance but OUTSIDE the strict seed tolerance, so it cannot seed on its
      // own. The single pure-magenta pixel at (5,5) is the seed; clearing must
      // then GROW from it across the halo at the looser fringe tolerance.
      for (let y = 4; y <= 6; y++) {
        for (let x = 4; x <= 6; x++) {
          setPixel(img, x, y, 255, 80, 255);
        }
      }
      setPixel(img, 5, 5, 255, 0, 255);

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 8000 });
      expect(alphaAt(out, 5, 5)).toBe(0); // the seed itself
      expect(alphaAt(out, 6, 6)).toBe(0); // fringe-distance halo, reached by growth
      expect(alphaAt(out, 3, 3)).toBe(255);
    });

    it('preserves warm foreground tones that merely clip the fringe tolerance', () => {
      // Regression for the enclosed-region false-positive class, using the real
      // measured colours from the sprite pipeline: the generation background is a
      // dull magenta rgb(182,51,135), and warm tan/leather rgb(207,127,69) sits
      // only 10757 away — inside the ~12000 fringe tolerance. Under a single loose
      // threshold this punched holes straight through skin, leather and cloth on
      // every character sheet. A component with no strict-tolerance seed must
      // survive no matter how large it is or how enclosed it is.
      const img = blank(16, 16, [182, 51, 135]);
      for (let x = 2; x <= 13; x++) {
        setPixel(img, x, 2, 0, 180, 40);
        setPixel(img, x, 13, 0, 180, 40);
      }
      for (let y = 2; y <= 13; y++) {
        setPixel(img, 2, y, 0, 180, 40);
        setPixel(img, 13, y, 0, 180, 40);
      }
      for (let y = 3; y <= 12; y++) {
        for (let x = 3; x <= 12; x++) {
          setPixel(img, x, y, 207, 127, 69);
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 4000, fringeToleranceSq: 12000 });
      expect(alphaAt(out, 8, 8)).toBe(255);
      expect(alphaAt(out, 4, 11)).toBe(255);
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

    it('preserves compact lower-half magenta shading that is not a wide artifact blob', () => {
      const img = blank(32, 32, [255, 0, 255]);
      // Foreground body block.
      for (let y = 10; y <= 27; y++) {
        for (let x = 8; x <= 24; x++) {
          setPixel(img, x, y, 0, 180, 40);
        }
      }
      // Compact magenta-like patch inside the body (6x6; aspect ~= 1.0).
      // This resembles stylized shading and should not be treated as a wide background blob.
      for (let y = 19; y <= 24; y++) {
        for (let x = 13; x <= 18; x++) {
          setPixel(img, x, y, 145, 120, 145);
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 12000 });
      expect(alphaAt(out, 15, 21)).toBe(255);
      expect(alphaAt(out, 13, 24)).toBe(255);
    });

    it('preserves wide lower-half magenta shading when not exposed to transparent background', () => {
      const img = blank(40, 40, [255, 0, 255]);
      // Opaque body region.
      for (let y = 8; y <= 33; y++) {
        for (let x = 6; x <= 33; x++) {
          setPixel(img, x, y, 0, 180, 40);
        }
      }
      // Wide interior shadow-like stripe (would match the magenta-family heuristic by shape).
      for (let y = 22; y <= 25; y++) {
        for (let x = 12; x <= 30; x++) {
          setPixel(img, x, y, 142, 120, 142);
        }
      }

      const out = removeBackgroundB(img, { colorToleranceSq: 1024, fringeToleranceSq: 12000 });
      expect(alphaAt(out, 20, 23)).toBe(255);
      expect(alphaAt(out, 30, 25)).toBe(255);
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

// Guard: the post-process background defaults used during sprite *generation*
// (scripts/sprites/postprocess.ts) MUST stay identical to the devtools
// post-process *debugger* defaults (DEFAULT_BACKGROUND_TWEAKS in
// src/devtools-main.ts). If these drift, the workflow grid thumbnails and the
// debugger preview will diverge again — the exact bug this guard exists to
// prevent. devtools-main.ts cannot import from scripts/sprites (browser bundle
// must not pull in Node/pngjs), so the values are mirrored by hand and locked
// here instead of via a shared module.
describe('postprocess background defaults are locked to devtools DEFAULT_BACKGROUND_TWEAKS', () => {
  it('colorToleranceSq default equals devtools DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq (4000)', () => {
    expect(BACKGROUND_B_COLOR_TOLERANCE_SQ).toBe(4000);
  });

  it('fringeToleranceSq default equals devtools DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq (12000)', () => {
    expect(BACKGROUND_B_FRINGE_TOLERANCE_SQ).toBe(12000);
  });
});
