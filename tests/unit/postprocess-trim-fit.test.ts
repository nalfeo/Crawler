import { describe, expect, it } from 'vitest';
import {
  scaleToMinDimension,
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
