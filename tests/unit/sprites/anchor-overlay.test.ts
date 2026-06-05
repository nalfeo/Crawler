/**
 * Unit tests for `buildAnchorOverlay`.
 *
 * The overlay PNG is the gallery's only signal that an anchor was derived
 * for a variant. The contract is narrow on purpose: one fully opaque red
 * pixel at the exact anchor coord, everything else fully transparent. If
 * this drifts (anti-aliasing, drift by 1 px, mis-channel), the gallery
 * will silently mis-render hundreds of candidates.
 */

import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import fc from 'fast-check';
import { buildAnchorOverlay } from '../../../scripts/sprites/anchor-overlay.js';

interface ParsedPixel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function decode(buffer: Buffer): { width: number; height: number; pixel: (x: number, y: number) => ParsedPixel } {
  const png = PNG.sync.read(buffer);
  return {
    width: png.width,
    height: png.height,
    pixel: (x, y) => {
      const idx = (y * png.width + x) * 4;
      return {
        r: png.data[idx]!,
        g: png.data[idx + 1]!,
        b: png.data[idx + 2]!,
        a: png.data[idx + 3]!,
      };
    },
  };
}

function findRedPixels(buffer: Buffer): Array<{ x: number; y: number }> {
  const { width, height, pixel } = decode(buffer);
  const reds: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      if (p.a !== 0) {
        // Any non-transparent pixel must be exactly opaque red. Anything
        // else is a bug (anti-aliasing, wrong channel order, etc.).
        expect(p).toEqual({ r: 255, g: 0, b: 0, a: 255 });
        reds.push({ x, y });
      }
    }
  }
  return reds;
}

describe('buildAnchorOverlay', () => {
  it('marks a single red pixel at the center of a 16x16 sprite', () => {
    const out = buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 8, y: 12 } });
    const reds = findRedPixels(out);
    expect(reds).toEqual([{ x: 8, y: 12 }]);
  });

  it('places the pixel at the top-left corner (0,0)', () => {
    const out = buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 0, y: 0 } });
    expect(findRedPixels(out)).toEqual([{ x: 0, y: 0 }]);
  });

  it('places the pixel at the bottom-right corner (15,15)', () => {
    const out = buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 15, y: 15 } });
    expect(findRedPixels(out)).toEqual([{ x: 15, y: 15 }]);
  });

  it('returns a fully transparent PNG when anchor is null', () => {
    const out = buildAnchorOverlay({ width: 16, height: 16, anchor: null });
    expect(findRedPixels(out)).toEqual([]);
    const { width, height } = decode(out);
    expect(width).toBe(16);
    expect(height).toBe(16);
  });

  it('is deterministic — same input yields identical bytes', () => {
    const a = buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 4, y: 9 } });
    const b = buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 4, y: 9 } });
    expect(a.equals(b)).toBe(true);
  });

  it('supports non-16 dimensions (e.g. 32x32)', () => {
    const out = buildAnchorOverlay({ width: 32, height: 32, anchor: { x: 31, y: 0 } });
    const { width, height } = decode(out);
    expect(width).toBe(32);
    expect(height).toBe(32);
    expect(findRedPixels(out)).toEqual([{ x: 31, y: 0 }]);
  });

  it('throws on out-of-bounds anchor', () => {
    expect(() => buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 16, y: 0 } })).toThrow(
      /out of/,
    );
    expect(() => buildAnchorOverlay({ width: 16, height: 16, anchor: { x: -1, y: 0 } })).toThrow(
      /out of/,
    );
  });

  it('throws on non-positive dimensions', () => {
    expect(() => buildAnchorOverlay({ width: 0, height: 16, anchor: null })).toThrow(/width/);
    expect(() => buildAnchorOverlay({ width: 16, height: -1, anchor: null })).toThrow(/height/);
  });

  it('property: any in-bounds anchor produces exactly one red pixel at exactly that coord', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 0, max: 15 }),
        (x, y) => {
          const out = buildAnchorOverlay({ width: 16, height: 16, anchor: { x, y } });
          const reds = findRedPixels(out);
          expect(reds).toEqual([{ x, y }]);
        },
      ),
    );
  });
});
