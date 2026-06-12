/**
 * Tests for the sheet slicer.
 *
 * Strategy:
 * - Hand-rolled cases nail down the contract (size guards, reading order,
 *   empty-cell skipping, byte-exact cell content).
 * - A fast-check property test asserts the universal invariant: for any
 *   r×c grid of distinctly colored cells, the slicer returns r*c buffers
 *   in row-major order and each one is a solid PNG of its cell's color.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PNG } from 'pngjs';
import { computeSliceMapV2, sliceSheet } from '../../../scripts/sprites/slice-sheet.js';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function encodeSolidGridSheet(
  rows: number,
  cols: number,
  cellSize: number,
  cellColor: (row: number, col: number) => Rgb,
): Buffer {
  const width = cols * cellSize;
  const height = rows * cellSize;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const r = Math.floor(y / cellSize);
    for (let x = 0; x < width; x++) {
      const c = Math.floor(x / cellSize);
      const color = cellColor(r, c);
      const idx = (y * width + x) * 4;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function dominantColor(buf: Buffer): Rgb {
  const png = PNG.sync.read(buf);
  // Sample the center pixel; all pixels in a cell share a color in our fixtures.
  const x = Math.floor(png.width / 2);
  const y = Math.floor(png.height / 2);
  const i = (y * png.width + x) * 4;
  return { r: png.data[i]!, g: png.data[i + 1]!, b: png.data[i + 2]! };
}

describe('sliceSheet', () => {
  it('returns rows*cols buffers in row-major order with correct cell content', () => {
    const sheet = encodeSolidGridSheet(2, 3, 4, (r, c) => ({
      r: r * 80 + 10,
      g: c * 80 + 10,
      b: (r * 3 + c) * 30 + 10,
    }));
    const slices = sliceSheet(sheet, { rows: 2, cols: 3 });
    expect(slices).toHaveLength(6);
    let i = 0;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        const color = dominantColor(slices[i++]!);
        expect(color).toEqual({ r: r * 80 + 10, g: c * 80 + 10, b: (r * 3 + c) * 30 + 10 });
      }
    }
  });

  describe('computeSliceMapV2', () => {
    it('trims large outer margins down to a 1px border around content', () => {
      const width = 24;
      const height = 12;
      const png = new PNG({ width, height });
      // White background.
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 255;
        png.data[i + 1] = 255;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
      }
      // Two black sprites with a wide interior separator.
      for (let y = 3; y <= 8; y++) {
        for (let x = 5; x <= 8; x++) {
          const i = (y * width + x) * 4;
          png.data[i] = 0;
          png.data[i + 1] = 0;
          png.data[i + 2] = 0;
        }
        for (let x = 14; x <= 17; x++) {
          const i = (y * width + x) * 4;
          png.data[i] = 0;
          png.data[i + 1] = 0;
          png.data[i + 2] = 0;
        }
      }
      // Sparse edge noise should not prevent margin trimming.
      {
        const i0 = (1 * width + 0) * 4;
        png.data[i0] = 0;
        png.data[i0 + 1] = 0;
        png.data[i0 + 2] = 0;
        const i1 = ((height - 2) * width + (width - 1)) * 4;
        png.data[i1] = 0;
        png.data[i1 + 1] = 0;
        png.data[i1 + 2] = 0;
      }

      const map = computeSliceMapV2(PNG.sync.write(png));
      expect(map.rows).toBe(1);
      expect(map.cols).toBe(2);

      const left = map.cells[0]!;
      const right = map.cells[1]!;
      // min content x/y is (5,3), max content x/y is (17,8) => trim to 1px border.
      expect(left.x0).toBe(4);
      expect(left.y0).toBe(2);
      expect(right.x0 + right.w).toBe(19);
      expect(left.y0 + left.h).toBe(10);
    });
  });

  it('emits cells at the cell-native resolution, not the whole sheet', () => {
    const sheet = encodeSolidGridSheet(2, 2, 8, () => ({ r: 0, g: 0, b: 0 }));
    const slices = sliceSheet(sheet, { rows: 2, cols: 2 });
    for (const slice of slices) {
      const png = PNG.sync.read(slice);
      expect(png.width).toBe(8);
      expect(png.height).toBe(8);
    }
  });

  it('skips empty cells and preserves order for the rest', () => {
    // 3x3 sheet, skip the center cell (row 1, col 1) -> 8 outputs.
    const sheet = encodeSolidGridSheet(3, 3, 4, (r, c) => ({
      r: r * 100,
      g: c * 100,
      b: 50,
    }));
    const slices = sliceSheet(sheet, { rows: 3, cols: 3, emptyCells: [[1, 1]] });
    expect(slices).toHaveLength(8);
    const expectedColors: Rgb[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (r === 1 && c === 1) continue;
        expectedColors.push({ r: r * 100, g: c * 100, b: 50 });
      }
    }
    slices.forEach((slice, i) => expect(dominantColor(slice)).toEqual(expectedColors[i]!));
  });

  it('throws when the sheet does not divide evenly into the grid', () => {
    const sheet = encodeSolidGridSheet(2, 2, 5, () => ({ r: 0, g: 0, b: 0 }));
    // Same sheet (10x10) but ask for a 3x3 grid — 10 is not divisible by 3.
    expect(() => sliceSheet(sheet, { rows: 3, cols: 3 })).toThrow(/evenly divisible/);
  });

  it('throws on degenerate grid shapes', () => {
    const sheet = encodeSolidGridSheet(1, 1, 4, () => ({ r: 0, g: 0, b: 0 }));
    expect(() => sliceSheet(sheet, { rows: 0, cols: 1 })).toThrow(/>= 1/);
    expect(() => sliceSheet(sheet, { rows: 1, cols: 0 })).toThrow(/>= 1/);
  });

  it('can nudge vertical slice bounds to recover bottom overflow from a cell', () => {
    const width = 8;
    const height = 16;
    const png = new PNG({ width, height });
    // White background.
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 255;
      png.data[i + 1] = 255;
      png.data[i + 2] = 255;
      png.data[i + 3] = 255;
    }
    // First-row sprite: red torso from y=2..7 and green "feet" that spill into y=8.
    for (let y = 2; y <= 7; y++) {
      for (let x = 3; x <= 4; x++) {
        const i = (y * width + x) * 4;
        png.data[i] = 220;
        png.data[i + 1] = 30;
        png.data[i + 2] = 30;
      }
    }
    for (let x = 3; x <= 4; x++) {
      const i = (8 * width + x) * 4;
      png.data[i] = 40;
      png.data[i + 1] = 220;
      png.data[i + 2] = 40;
    }
    const sheet = PNG.sync.write(png);

    const fixed = sliceSheet(sheet, { rows: 2, cols: 1 });
    const nudged = sliceSheet(sheet, {
      rows: 2,
      cols: 1,
      autoNudge: {
        enabled: true,
        maxVerticalShiftPx: 2,
        backgroundDistanceThreshold: 16,
        edgeBandPx: 1,
      },
    });
    const fixedPng = PNG.sync.read(fixed[0]!);
    const nudgedPng = PNG.sync.read(nudged[0]!);
    const hasGreen = (img: PNG): boolean => {
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i] === 40 && img.data[i + 1] === 220 && img.data[i + 2] === 40) {
          return true;
        }
      }
      return false;
    };
    expect(hasGreen(fixedPng)).toBe(false);
    expect(hasGreen(nudgedPng)).toBe(true);
  });

  // Property: for any small NxM grid with arbitrary distinct cell colors,
  // slicing recovers the cells in row-major order at the right resolution.
  it('property: round-trips an arbitrary NxM grid of solid-color cells', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 2, max: 8 }),
        (rows, cols, cellSize) => {
          const sheet = encodeSolidGridSheet(rows, cols, cellSize, (r, c) => ({
            // Encode (r, c) into the color so we can verify ordering precisely.
            r: r * 17 + 1,
            g: c * 17 + 1,
            b: (r * cols + c) * 5 + 1,
          }));
          const slices = sliceSheet(sheet, { rows, cols });
          if (slices.length !== rows * cols) return false;
          let i = 0;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const slice = slices[i]!;
              const png = PNG.sync.read(slice);
              if (png.width !== cellSize || png.height !== cellSize) return false;
              const color = dominantColor(slice);
              if (
                color.r !== r * 17 + 1 ||
                color.g !== c * 17 + 1 ||
                color.b !== (r * cols + c) * 5 + 1
              ) {
                return false;
              }
              i++;
            }
          }
          return true;
        },
      ),
      { numRuns: 30 },
    );
  });
});
