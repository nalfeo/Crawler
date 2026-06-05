import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PNG } from 'pngjs';
import {
  quantizeToPalette,
  hardThresholdAlpha,
  type RgbaImage,
} from '../../scripts/sprites/postprocess.js';
import type { PaletteColors, RgbTriple } from '../../scripts/sprites/brief-schema.js';

function imageFromRgba(
  width: number,
  height: number,
  pixels: ReadonlyArray<readonly [number, number, number, number]>,
): RgbaImage {
  if (pixels.length !== width * height) {
    throw new Error(`pixel count ${pixels.length} != ${width}*${height}`);
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i] as readonly [number, number, number, number];
    data[i * 4] = p[0];
    data[i * 4 + 1] = p[1];
    data[i * 4 + 2] = p[2];
    data[i * 4 + 3] = p[3];
  }
  return { width, height, data };
}

const PALETTE_4: PaletteColors = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

describe('quantizeToPalette', () => {
  it('snaps each opaque pixel to the nearest palette entry by Euclidean distance', () => {
    // 2x2 image: dark gray, near-red, near-green, near-blue
    const img = imageFromRgba(2, 2, [
      [10, 10, 10, 255],
      [200, 30, 30, 255],
      [30, 200, 30, 255],
      [30, 30, 200, 255],
    ]);
    const out = quantizeToPalette(img, PALETTE_4);
    // Pixel-identical golden output:
    expect(Array.from(out.data)).toEqual([
      0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    ]);
  });

  it('preserves transparent pixels (does not change RGB or alpha)', () => {
    const img = imageFromRgba(1, 2, [
      [123, 45, 67, 0],
      [200, 30, 30, 255],
    ]);
    const out = quantizeToPalette(img, PALETTE_4);
    // First pixel is transparent; original RGB is preserved.
    expect(out.data[0]).toBe(123);
    expect(out.data[1]).toBe(45);
    expect(out.data[2]).toBe(67);
    expect(out.data[3]).toBe(0);
    // Second pixel is snapped to red.
    expect(out.data[4]).toBe(255);
    expect(out.data[5]).toBe(0);
    expect(out.data[6]).toBe(0);
    expect(out.data[7]).toBe(255);
  });

  it('breaks ties on first-match (deterministic regardless of palette order beyond ties)', () => {
    // Equidistant from two palette entries; first wins.
    const palette: PaletteColors = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    const img = imageFromRgba(1, 1, [[5, 0, 0, 255]]);
    const out = quantizeToPalette(img, palette);
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([0, 0, 0]);
  });

  it('throws on an empty palette', () => {
    const img = imageFromRgba(1, 1, [[5, 0, 0, 255]]);
    expect(() => quantizeToPalette(img, [])).toThrow();
  });

  it('property: every output opaque pixel is in the palette', () => {
    const paletteArb = fc.array(
      fc.tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      ),
      { minLength: 1, maxLength: 8 },
    );
    const pixelArb = fc.tuple(
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.constantFrom(0, 255),
    );

    fc.assert(
      fc.property(
        paletteArb,
        fc.array(pixelArb, { minLength: 1, maxLength: 64 }),
        (palette, pixels) => {
          const w = pixels.length;
          const img = imageFromRgba(w, 1, pixels);
          const paletteTriples: PaletteColors = palette as ReadonlyArray<RgbTriple>;
          const out = quantizeToPalette(img, paletteTriples);
          const set = new Set(palette.map((c) => `${c[0]},${c[1]},${c[2]}`));
          for (let i = 0; i < out.data.length; i += 4) {
            if (out.data[i + 3] === 0) continue; // transparent pixels keep original RGB
            const key = `${out.data[i]},${out.data[i + 1]},${out.data[i + 2]}`;
            if (!set.has(key)) return false;
          }
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('hardThresholdAlpha', () => {
  it('promotes alpha > 128 to 255 and demotes alpha <= 128 to 0', () => {
    const img = imageFromRgba(1, 5, [
      [0, 0, 0, 0],
      [0, 0, 0, 128],
      [0, 0, 0, 129],
      [0, 0, 0, 200],
      [0, 0, 0, 255],
    ]);
    const out = hardThresholdAlpha(img);
    const alphas = [out.data[3], out.data[7], out.data[11], out.data[15], out.data[19]];
    expect(alphas).toEqual([0, 0, 255, 255, 255]);
  });
});

describe('quantize golden round-trip via PNG encode', () => {
  // Smoke test that a known palette + known input produces a known PNG byte sequence.
  it('produces a stable RGBA byte array for a tiny known input', () => {
    const png = new PNG({ width: 2, height: 1 });
    png.data[0] = 250;
    png.data[1] = 5;
    png.data[2] = 5;
    png.data[3] = 255;
    png.data[4] = 5;
    png.data[5] = 5;
    png.data[6] = 250;
    png.data[7] = 255;
    const buffer = PNG.sync.write(png);
    const decoded = PNG.sync.read(buffer);
    const decodedImage: RgbaImage = {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    };
    const quantized = quantizeToPalette(decodedImage, PALETTE_4);
    expect(Array.from(quantized.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });
});
