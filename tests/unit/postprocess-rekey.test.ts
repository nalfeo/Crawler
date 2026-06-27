import { describe, expect, it } from 'vitest';
import { removeReintroducedBackground, type RgbaImage } from '../../scripts/sprites/postprocess.js';

const MAGENTA: readonly [number, number, number] = [255, 0, 255];

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

describe('removeReintroducedBackground', () => {
  it('clears reintroduced background fringe keyed against the ORIGINAL corners', () => {
    // The original source had magenta corners (the true background colour).
    const source = blank(6, 6, MAGENTA);

    // After a fit-resize the canvas is transparent-padded: its own corners are
    // (0,0,0,0), NOT magenta. A magenta fringe pixel adjacent to that padding
    // is the "pink that stretching brought back".
    const resized: RgbaImage = { width: 6, height: 6, data: new Uint8Array(6 * 6 * 4) };
    // Opaque subject block in the middle.
    for (let y = 2; y <= 3; y++) {
      for (let x = 2; x <= 3; x++) {
        setPixel(resized, x, y, 0, 180, 40);
      }
    }
    // Reintroduced magenta fringe touching the transparent border at (1,2).
    setPixel(resized, 1, 2, 250, 5, 250);

    const out = removeReintroducedBackground(resized, source);

    // Reintroduced fringe is cleared.
    expect(alphaAt(out, 1, 2)).toBe(0);
    // Genuine subject pixels are untouched.
    expect(alphaAt(out, 2, 2)).toBe(255);
    expect(alphaAt(out, 3, 3)).toBe(255);
  });

  it('does not eat dark foreground that abuts transparent padding', () => {
    // Keying on the resized image's own (0,0,0) corners would wrongly remove
    // black foreground. Keying on the original magenta corners must not.
    const source = blank(5, 5, MAGENTA);
    const resized: RgbaImage = { width: 5, height: 5, data: new Uint8Array(5 * 5 * 4) };
    // Pure-black foreground pixel directly adjacent to transparent padding.
    setPixel(resized, 2, 2, 0, 0, 0);

    const out = removeReintroducedBackground(resized, source);

    expect(alphaAt(out, 2, 2)).toBe(255);
  });
});
