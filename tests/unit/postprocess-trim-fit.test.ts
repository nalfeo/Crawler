import { describe, expect, it } from 'vitest';
import {
  SUBJECT_TRIM_MARGIN_FRACTION,
  scaleToMinDimension,
  subjectTrimMarginPx,
  trimTransparentEdges,
  type RgbaImage,
} from '../../scripts/sprites/postprocess.js';

function mkImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function setPixel(image: RgbaImage, x: number, y: number, alpha = 255): void {
  const idx = (y * image.width + x) * 4;
  image.data[idx] = 255;
  image.data[idx + 1] = 255;
  image.data[idx + 2] = 255;
  image.data[idx + 3] = alpha;
}

function alphaAt(image: RgbaImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3] ?? 0;
}

describe('trimTransparentEdges', () => {
  it('returns 0x0 when the image is fully transparent', () => {
    const image = mkImage(4, 4);
    const out = trimTransparentEdges(image);
    expect(out.width).toBe(0);
    expect(out.height).toBe(0);
    expect(out.data.length).toBe(0);
  });

  it('trims transparent margins to the opaque bounding box', () => {
    const image = mkImage(6, 5);
    setPixel(image, 2, 1);
    setPixel(image, 4, 3);

    const out = trimTransparentEdges(image);
    expect(out.width).toBe(3);
    expect(out.height).toBe(3);
    expect(alphaAt(out, 0, 0)).toBe(255);
    expect(alphaAt(out, 2, 2)).toBe(255);
  });

  it('pads the bounding box with a uniform transparent margin when border > 0', () => {
    const image = mkImage(8, 8);
    setPixel(image, 3, 3);
    setPixel(image, 5, 5);

    const out = trimTransparentEdges(image, 2);
    // Tight box is 3x3; border=2 adds 2 transparent rows/cols on every edge.
    expect(out.width).toBe(7);
    expect(out.height).toBe(7);
    // Every edge row/column is fully transparent.
    for (let x = 0; x < out.width; x++) {
      expect(alphaAt(out, x, 0)).toBe(0);
      expect(alphaAt(out, x, out.height - 1)).toBe(0);
    }
    for (let y = 0; y < out.height; y++) {
      expect(alphaAt(out, 0, y)).toBe(0);
      expect(alphaAt(out, out.width - 1, y)).toBe(0);
    }
    // Opaque content is centered within the padded canvas.
    expect(alphaAt(out, 2, 2)).toBe(255);
    expect(alphaAt(out, 4, 4)).toBe(255);
  });

  it('clamps a negative or fractional border to a non-negative integer', () => {
    const image = mkImage(6, 6);
    setPixel(image, 2, 2);
    setPixel(image, 3, 3);

    expect(trimTransparentEdges(image, -5).width).toBe(2);
    expect(trimTransparentEdges(image, 1.9).width).toBe(2 + 1 * 2);
  });
});

describe('subjectTrimMarginPx', () => {
  it('scales with the larger subject dimension', () => {
    expect(subjectTrimMarginPx(100, 50)).toBe(Math.round(100 * SUBJECT_TRIM_MARGIN_FRACTION));
    expect(subjectTrimMarginPx(50, 200)).toBe(Math.round(200 * SUBJECT_TRIM_MARGIN_FRACTION));
  });

  it('never returns less than 1px even for tiny subjects', () => {
    expect(subjectTrimMarginPx(1, 1)).toBe(1);
    expect(subjectTrimMarginPx(4, 4)).toBe(1);
  });
});

describe('scaleToMinDimension', () => {
  it('returns unchanged image when both dimensions are already >= min', () => {
    const image = mkImage(8, 8);
    setPixel(image, 4, 4);

    const out = scaleToMinDimension(image, 6);
    expect(out).toBe(image);
  });

  it('upscales non-square images while preserving aspect ratio', () => {
    const image = mkImage(2, 4);
    setPixel(image, 1, 1);

    const out = scaleToMinDimension(image, 6);
    expect(out.width).toBe(6);
    expect(out.height).toBe(12);
    // Opaque source pixel should remain represented after nearest-neighbor scaling.
    const hasOpaque = out.data.some((_, i) => i % 4 === 3 && out.data[i] === 255);
    expect(hasOpaque).toBe(true);
  });
});
