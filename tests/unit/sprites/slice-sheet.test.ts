/**
 * Tests for the content-aware sheet slicer.
 *
 * The slicer infers cut positions from pixel data (background bands) rather than
 * an equal-division `rows × cols` grid — it is the exact same map the
 * post-process debugger draws, so what the debugger previews is what generation
 * produces. These tests pin that contract:
 * - outer margins are trimmed to a 1px border around content;
 * - interior background gutters become cuts (grid is detected, not assumed);
 * - cells come back in row-major reading order with non-overlapping bounds;
 * - `sliceSheetFromBrief` forwards only `emptyCells` — the brief's rows/cols do
 *   NOT drive slicing;
 * - a fast-check property asserts the universal invariant over arbitrary grids.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PNG } from 'pngjs';
import {
  computeSliceMap,
  sliceSheet,
  sliceSheetFromBrief,
} from '../../../scripts/sprites/slice-sheet.js';
import type { Brief } from '../../../scripts/sprites/brief-schema.js';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const BG: Rgb = { r: 255, g: 255, b: 255 };

/**
 * Encode a rows×cols grid of solid-colour blocks separated by background
 * gutters (plus an outer margin) on a white sheet. This mirrors a real sprite
 * sheet: sprites sit in a grid with visible background between them, which is
 * exactly what the content-aware slicer keys off.
 */
function encodeContentGrid(
  rows: number,
  cols: number,
  opts: {
    block: number;
    gutter: number;
    margin: number;
    color: (row: number, col: number) => Rgb;
  },
): Buffer {
  const { block, gutter, margin, color } = opts;
  const width = margin * 2 + cols * block + (cols - 1) * gutter;
  const height = margin * 2 + rows * block + (rows - 1) * gutter;
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = BG.r;
    png.data[i + 1] = BG.g;
    png.data[i + 2] = BG.b;
    png.data[i + 3] = 255;
  }
  const origin = (idx: number): number => margin + idx * (block + gutter);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const col = color(r, c);
      const x0 = origin(c);
      const y0 = origin(r);
      for (let y = y0; y < y0 + block; y++) {
        for (let x = x0; x < x0 + block; x++) {
          const i = (y * width + x) * 4;
          png.data[i] = col.r;
          png.data[i + 1] = col.g;
          png.data[i + 2] = col.b;
        }
      }
    }
  }
  return PNG.sync.write(png);
}

function containsColor(buf: Buffer, color: Rgb): boolean {
  const png = PNG.sync.read(buf);
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === color.r && png.data[i + 1] === color.g && png.data[i + 2] === color.b) {
      return true;
    }
  }
  return false;
}

describe('computeSliceMap (content-aware)', () => {
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

    const map = computeSliceMap(PNG.sync.write(png));
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

  it('detects the grid shape from background gutters, not a supplied rows/cols', () => {
    const sheet = encodeContentGrid(2, 3, {
      block: 6,
      gutter: 4,
      margin: 4,
      color: (r, c) => ({ r: 30 + r * 60, g: 30 + c * 60, b: 120 }),
    });
    const map = computeSliceMap(sheet);
    expect(map.rows).toBe(2);
    expect(map.cols).toBe(3);
    expect(map.cells).toHaveLength(6);
  });
});

describe('sliceSheet (content-aware)', () => {
  const BLOCK_COLORS: Rgb[][] = [
    [
      { r: 200, g: 20, b: 20 },
      { r: 20, g: 200, b: 20 },
    ],
    [
      { r: 20, g: 20, b: 200 },
      { r: 200, g: 200, b: 20 },
    ],
  ];

  function encode2x2(): Buffer {
    return encodeContentGrid(2, 2, {
      block: 6,
      gutter: 4,
      margin: 4,
      color: (r, c) => BLOCK_COLORS[r]![c]!,
    });
  }

  it('extracts content-aware cells in reading order with non-overlapping bounds', () => {
    const sheet = encode2x2();
    const map = computeSliceMap(sheet);
    expect(map.rows).toBe(2);
    expect(map.cols).toBe(2);

    const cells = sliceSheet(sheet);
    expect(cells).toHaveLength(4);

    // Reading order is row-major: (0,0), (0,1), (1,0), (1,1).
    const expectedOrder: Rgb[] = [
      BLOCK_COLORS[0]![0]!,
      BLOCK_COLORS[0]![1]!,
      BLOCK_COLORS[1]![0]!,
      BLOCK_COLORS[1]![1]!,
    ];
    cells.forEach((cell, i) => {
      const own = expectedOrder[i]!;
      expect(containsColor(cell, own)).toBe(true);
      // No neighbor leakage: this cell must not contain any other block color.
      for (const other of expectedOrder) {
        if (other === own) continue;
        expect(containsColor(cell, other)).toBe(false);
      }
    });
  });

  // Property: for any small rows×cols grid of distinctly coloured blocks
  // separated by background gutters, the content-aware slicer recovers exactly
  // rows*cols cells in row-major order, each containing only its own colour.
  it('property: recovers an arbitrary gridded sheet in reading order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 3, max: 8 }),
        fc.integer({ min: 2, max: 5 }),
        (rows, cols, block, gutter) => {
          // Encode (r, c) into distinct, far-from-white channels: R tracks the
          // row, G tracks the column, so no two blocks share both channels.
          const color = (r: number, c: number): Rgb => ({
            r: 10 + r * 40,
            g: 10 + c * 40,
            b: 30 + (r * cols + c) * 7,
          });
          const sheet = encodeContentGrid(rows, cols, { block, gutter, margin: 3, color });
          const cells = sliceSheet(sheet);
          if (cells.length !== rows * cols) return false;
          let i = 0;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (!containsColor(cells[i]!, color(r, c))) return false;
              i++;
            }
          }
          return true;
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('sliceSheetFromBrief', () => {
  const BLOCK_COLORS: Rgb[][] = [
    [
      { r: 200, g: 20, b: 20 },
      { r: 20, g: 200, b: 20 },
    ],
    [
      { r: 20, g: 20, b: 200 },
      { r: 200, g: 200, b: 20 },
    ],
  ];

  function encode2x2(): Buffer {
    return encodeContentGrid(2, 2, {
      block: 6,
      gutter: 4,
      margin: 4,
      color: (r, c) => BLOCK_COLORS[r]![c]!,
    });
  }

  it('skips brief-declared empty cells and preserves reading order', () => {
    const sheet = encode2x2();
    const brief = {
      generation: {
        sheet: {
          rows: 2,
          cols: 2,
          emptyCells: [[0, 0]] as ReadonlyArray<readonly [number, number]>,
        },
      },
    } as unknown as Brief;

    const cells = sliceSheetFromBrief(sheet, brief);
    expect(cells).toHaveLength(3);

    // (0,0) is skipped; the rest stay in reading order.
    const expectedOrder: Rgb[] = [BLOCK_COLORS[0]![1]!, BLOCK_COLORS[1]![0]!, BLOCK_COLORS[1]![1]!];
    cells.forEach((cell, i) => {
      expect(containsColor(cell, expectedOrder[i]!)).toBe(true);
    });
    // The skipped cell's color must not appear in any extracted cell.
    const skipped = BLOCK_COLORS[0]![0]!;
    for (const cell of cells) {
      expect(containsColor(cell, skipped)).toBe(false);
    }
  });

  it('ignores the brief rows/cols and slices by content (3 sprites, not 2×2=4)', () => {
    // Brief claims a 2×2 grid, but the actual sheet has a single row of three
    // sprites. Content-aware slicing must follow the pixels, returning 3 cells.
    const sheet = encodeContentGrid(1, 3, {
      block: 6,
      gutter: 4,
      margin: 4,
      color: (_r, c) => ({ r: 200, g: 20 + c * 60, b: 40 }),
    });
    const brief = {
      generation: {
        sheet: {
          rows: 2,
          cols: 2,
          emptyCells: [] as ReadonlyArray<readonly [number, number]>,
        },
      },
    } as unknown as Brief;

    const cells = sliceSheetFromBrief(sheet, brief);
    expect(cells).toHaveLength(3);
  });
});
