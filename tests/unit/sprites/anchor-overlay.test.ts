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

function decode(buffer: Buffer): {
  width: number;
  height: number;
  pixel: (x: number, y: number) => ParsedPixel;
} {
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
  it('marks a 3×3 crosshair at the anchor for a 16x16 sprite', () => {
    const out = buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 8, y: 12 } });
    const reds = findRedPixels(out);
    // Center + 4 cardinal neighbors
    expect(reds).toEqual(
      expect.arrayContaining([
        { x: 8, y: 12 },
        { x: 7, y: 12 },
        { x: 9, y: 12 },
        { x: 8, y: 11 },
        { x: 8, y: 13 },
      ]),
    );
    expect(reds).toHaveLength(5);
  });

  it('clips crosshair at the top-left corner (0,0) — only 3 pixels', () => {
    const out = buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 0, y: 0 } });
    const reds = findRedPixels(out);
    // Left and up arms clipped
    expect(reds).toEqual(
      expect.arrayContaining([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]),
    );
    expect(reds).toHaveLength(3);
  });

  it('clips crosshair at the bottom-right corner (15,15) — only 3 pixels', () => {
    const out = buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 15, y: 15 } });
    const reds = findRedPixels(out);
    expect(reds).toEqual(
      expect.arrayContaining([
        { x: 15, y: 15 },
        { x: 14, y: 15 },
        { x: 15, y: 14 },
      ]),
    );
    expect(reds).toHaveLength(3);
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

  it('supports non-16 dimensions (e.g. 32x32) with edge clipping', () => {
    const out = buildAnchorOverlay({ width: 32, height: 32, anchor: { x: 31, y: 0 } });
    const { width, height } = decode(out);
    expect(width).toBe(32);
    expect(height).toBe(32);
    const reds = findRedPixels(out);
    // Right arm and top arm clipped
    expect(reds).toEqual(
      expect.arrayContaining([
        { x: 31, y: 0 },
        { x: 30, y: 0 },
        { x: 31, y: 1 },
      ]),
    );
    expect(reds).toHaveLength(3);
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

  it('property: any in-bounds anchor produces 3–5 red pixels including the anchor coord', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 15 }), fc.integer({ min: 0, max: 15 }), (x, y) => {
        const out = buildAnchorOverlay({ width: 16, height: 16, anchor: { x, y } });
        const reds = findRedPixels(out);
        // Center is always present
        expect(reds).toEqual(expect.arrayContaining([{ x, y }]));
        // 3 (corner) to 5 (interior) pixels depending on edge clipping
        expect(reds.length).toBeGreaterThanOrEqual(3);
        expect(reds.length).toBeLessThanOrEqual(5);
      }),
    );
  });
});
