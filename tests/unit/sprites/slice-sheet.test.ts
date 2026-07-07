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
 * - the *bare* map (no `expectedGrid`) is pure content-aware — the brief's
 *   rows/cols do NOT drive it (this is the debugger path);
 * - on the generation path `sliceSheetFromBrief` passes the brief's rows/cols as
 *   `expectedGrid`, which reconciles the detected grid to the commanded cell
 *   count (drop spurious gutters, or uniform-split when under-segmented), so
 *   every sheet reaches human gallery review;
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

  it('reconciles a content/brief mismatch to the commanded cell count for human review', () => {
    // Brief commands a 2×2 grid, but the sheet drew a single row of three
    // sprites — a genuine generation error. The slicer no longer silently
    // follows the pixels on the generation path: it reconciles to the commanded
    // 2×2 = 4 cells (cols over-segmented 3→2 by dropping the least-even gutter;
    // rows under-segmented 1→2 via uniform fallback) so the sheet reaches human
    // gallery review, which rejects it. Human review — not the cell count — is
    // the semantic gate (product decision 2026-07-07).
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
    expect(cells).toHaveLength(4);
  });
});

describe('Bug B regression: inter-cell gutters govern the recovered grid', () => {
  // A correctly-gutted 4×4 sheet slices into exactly 16 cells — the honest
  // target the generate-one gate requires. This is what the strengthened sheet
  // prompt (mandatory background gutter between every row AND column) is meant
  // to make gpt-image-1 draw.
  it('recovers exactly 16 cells from a 4×4 sheet with gutters on both axes', () => {
    const sheet = encodeContentGrid(4, 4, {
      block: 8,
      gutter: 4,
      margin: 4,
      color: (r, c) => ({ r: 10 + r * 40, g: 10 + c * 40, b: 60 }),
    });
    const map = computeSliceMap(sheet);
    expect(map.rows).toBe(4);
    expect(map.cols).toBe(4);
    expect(map.cells).toHaveLength(16);
  });

  // The incident: gpt-image-1 drew a 4×4 character sheet but adjacent columns
  // touched horizontally (the old prompt said "Horizontal side margins are
  // acceptable", so no vertical background channel was required). The
  // content-aware slicer keys off background bands, so it merged each pair of
  // touching columns and produced 8 cells — the exact "expected 16 cells,
  // slicer produced 8" failure. This pins the root cause WITHOUT changing the
  // slicer: the fix lives in the prompt (require the gutters). Four rows are
  // separated by full-width horizontal gutters; the four columns have only ONE
  // interior vertical background band (down the middle), so 4 rows × 2 detected
  // columns = 8.
  it('collapses 4×4 to 8 cells when adjacent columns touch (reproduces expected-16-produced-8)', () => {
    const block = 8;
    const gutter = 4;
    const margin = 4;
    const rows = 4;
    // Cols 0,1 touch; a single central gutter; cols 2,3 touch.
    const width = margin * 2 + 4 * block + gutter;
    const height = margin * 2 + rows * block + (rows - 1) * gutter;
    const png = new PNG({ width, height });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = BG.r;
      png.data[i + 1] = BG.g;
      png.data[i + 2] = BG.b;
      png.data[i + 3] = 255;
    }
    const colX = (c: number): number => {
      const base = margin + c * block;
      return c < 2 ? base : base + gutter;
    };
    const rowY = (r: number): number => margin + r * (block + gutter);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 4; c++) {
        const x0 = colX(c);
        const y0 = rowY(r);
        const color = { r: 10 + r * 40, g: 10 + c * 40, b: 60 };
        for (let y = y0; y < y0 + block; y++) {
          for (let x = x0; x < x0 + block; x++) {
            const i = (y * width + x) * 4;
            png.data[i] = color.r;
            png.data[i + 1] = color.g;
            png.data[i + 2] = color.b;
          }
        }
      }
    }
    const map = computeSliceMap(PNG.sync.write(png));
    expect(map.rows).toBe(4);
    expect(map.cols).toBe(2);
    expect(map.cells).toHaveLength(8);
  });
});

describe('computeSliceMap generation reconciliation (expectedGrid)', () => {
  const PALETTE: Rgb[] = [
    { r: 200, g: 20, b: 20 },
    { r: 20, g: 200, b: 20 },
    { r: 20, g: 20, b: 200 },
    { r: 200, g: 200, b: 20 },
    { r: 200, g: 20, b: 200 },
    { r: 20, g: 200, b: 200 },
  ];

  function fillBg(png: PNG): void {
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = BG.r;
      png.data[i + 1] = BG.g;
      png.data[i + 2] = BG.b;
      png.data[i + 3] = 255;
    }
  }

  // Encode one row of `logical` solid blocks; each block whose index is in
  // `splitAts` gets a 2px full-height background gap down its middle, so
  // content-aware detection sees `logical + splitAts.length` columns — exactly
  // the spurious-band artifact a gappy subject (rubble) produces on a real sheet.
  function encodeGappyRow(
    logical: number,
    splitAts: readonly number[],
  ): { sheet: Buffer; colors: Rgb[] } {
    const margin = 4;
    const block = 10;
    const gutter = 6;
    const width = margin * 2 + logical * block + (logical - 1) * gutter;
    const height = margin * 2 + block;
    const png = new PNG({ width, height });
    fillBg(png);
    const colors: Rgb[] = [];
    const y0 = margin;
    for (let c = 0; c < logical; c++) {
      const color = PALETTE[c % PALETTE.length]!;
      colors.push(color);
      const x0 = margin + c * (block + gutter);
      for (let y = y0; y < y0 + block; y++) {
        for (let x = x0; x < x0 + block; x++) {
          if (splitAts.includes(c) && x >= x0 + block / 2 - 1 && x < x0 + block / 2 + 1) continue;
          const i = (y * width + x) * 4;
          png.data[i] = color.r;
          png.data[i + 1] = color.g;
          png.data[i + 2] = color.b;
        }
      }
    }
    return { sheet: PNG.sync.write(png), colors };
  }

  // Y-axis analogue of encodeGappyRow: a vertical stack of `logical` solid blocks
  // (one column); each block in `splitAts` gets a 2px full-width background gap
  // through its middle, so content-aware detection over-segments the ROW axis.
  function encodeGappyColumn(
    logical: number,
    splitAts: readonly number[],
  ): { sheet: Buffer; colors: Rgb[] } {
    const margin = 4;
    const block = 10;
    const gutter = 6;
    const width = margin * 2 + block;
    const height = margin * 2 + logical * block + (logical - 1) * gutter;
    const png = new PNG({ width, height });
    fillBg(png);
    const colors: Rgb[] = [];
    const x0 = margin;
    for (let r = 0; r < logical; r++) {
      const color = PALETTE[r % PALETTE.length]!;
      colors.push(color);
      const y0 = margin + r * (block + gutter);
      for (let y = y0; y < y0 + block; y++) {
        for (let x = x0; x < x0 + block; x++) {
          if (splitAts.includes(r) && y >= y0 + block / 2 - 1 && y < y0 + block / 2 + 1) continue;
          const i = (y * width + x) * 4;
          png.data[i] = color.r;
          png.data[i + 1] = color.g;
          png.data[i + 2] = color.b;
        }
      }
    }
    return { sheet: PNG.sync.write(png), colors };
  }

  // One row of solid blocks with the given (uneven) widths separated by gutters,
  // with a 2px full-height background gap down the middle of block `splitAt`. The
  // real gutters therefore sit at NON-uniform x positions — a uniform-grid snap
  // would clip the wide block, but cutting at the detected gutters keeps every
  // uneven block intact.
  function encodeUnevenRow(
    widths: readonly number[],
    splitAt: number,
  ): { sheet: Buffer; colors: Rgb[] } {
    const margin = 4;
    const gutter = 6;
    const block = 10;
    const total = widths.reduce((a, b) => a + b, 0);
    const width = margin * 2 + total + (widths.length - 1) * gutter;
    const height = margin * 2 + block;
    const png = new PNG({ width, height });
    fillBg(png);
    const colors: Rgb[] = [];
    const y0 = margin;
    let x0 = margin;
    for (let c = 0; c < widths.length; c++) {
      const w = widths[c]!;
      const color = PALETTE[c % PALETTE.length]!;
      colors.push(color);
      for (let y = y0; y < y0 + block; y++) {
        for (let x = x0; x < x0 + w; x++) {
          if (c === splitAt && x >= x0 + w / 2 - 1 && x < x0 + w / 2 + 1) continue;
          const i = (y * width + x) * 4;
          png.data[i] = color.r;
          png.data[i + 1] = color.g;
          png.data[i + 2] = color.b;
        }
      }
      x0 += w + gutter;
    }
    return { sheet: PNG.sync.write(png), colors };
  }

  // Assert each sliced cell holds only its own block colour (clean recovery),
  // proving the slicer cut at real gutters rather than through a sprite.
  function assertColorIsolation(cells: Buffer[], colors: Rgb[]): void {
    expect(cells).toHaveLength(colors.length);
    cells.forEach((cell, i) => {
      expect(containsColor(cell, colors[i]!)).toBe(true);
      colors.forEach((other, j) => {
        if (j === i) return;
        expect(containsColor(cell, other)).toBe(false);
      });
    });
  }

  it('reconciles a single spurious over-segmented column to the commanded grid, cleanly', () => {
    // 4 logical blocks, block 1 split by an internal gap → content-aware sees 5.
    const { sheet, colors } = encodeGappyRow(4, [1]);

    // Without the hint, the spurious band over-segments to 5 columns (the bug).
    const bare = computeSliceMap(sheet);
    expect(bare.rows).toBe(1);
    expect(bare.cols).toBe(5);

    // With the commanded grid, the slicer reconciles to exactly 1×4.
    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(reconciled.rows).toBe(1);
    expect(reconciled.cols).toBe(4);
    expect(reconciled.cells).toHaveLength(4);

    // And the 4 recovered cells align with the 4 logical blocks (clean recovery,
    // not misaligned garbage): each cell holds only its own colour.
    const cells = sliceSheet(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(cells).toHaveLength(4);
    cells.forEach((cell, i) => {
      expect(containsColor(cell, colors[i]!)).toBe(true);
      for (let j = 0; j < colors.length; j++) {
        if (j === i) continue;
        expect(containsColor(cell, colors[j]!)).toBe(false);
      }
    });
  });

  it('is a no-op for a well-formed sheet whose content matches the commanded grid', () => {
    const sheet = encodeContentGrid(2, 2, {
      block: 8,
      gutter: 4,
      margin: 4,
      color: (r, c) => ({ r: 10 + r * 80, g: 10 + c * 80, b: 90 }),
    });
    const bare = computeSliceMap(sheet);
    const hinted = computeSliceMap(sheet, { expectedGrid: { rows: 2, cols: 2 } });
    expect(hinted.rows).toBe(bare.rows);
    expect(hinted.cols).toBe(bare.cols);
    expect(hinted.cells).toHaveLength(4);
    // Cells are still the clean content-aware cells.
    expect(sliceSheet(sheet, { expectedGrid: { rows: 2, cols: 2 } })).toHaveLength(4);
  });

  it('drops a spurious over-segmented ROW to the commanded grid, cleanly', () => {
    // 3 logical blocks stacked vertically, row 1 split by an internal gap →
    // content-aware sees 4 rows. Reconciliation must operate on the Y axis
    // independently and recover a clean 3×1.
    const { sheet, colors } = encodeGappyColumn(3, [1]);

    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBe(1);
    expect(bare.rows).toBe(4);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 3, cols: 1 } });
    expect(reconciled.cols).toBe(1);
    expect(reconciled.rows).toBe(3);
    expect(reconciled.cells).toHaveLength(3);

    assertColorIsolation(sliceSheet(sheet, { expectedGrid: { rows: 3, cols: 1 } }), colors);
  });

  it('drops MULTIPLE spurious columns to the commanded grid, cleanly', () => {
    // 4 logical blocks, blocks 1 AND 3 split → content-aware sees 6 columns. The
    // variance-minimising subset must drop BOTH phantom gutters and recover 1×4.
    const { sheet, colors } = encodeGappyRow(4, [1, 3]);

    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBe(6);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(reconciled.cols).toBe(4);
    expect(reconciled.cells).toHaveLength(4);

    assertColorIsolation(sliceSheet(sheet, { expectedGrid: { rows: 1, cols: 4 } }), colors);
  });

  it('cuts at real (uneven) gutters rather than snapping to a uniform grid', () => {
    // Three blocks of very different widths (10, 16, 10) with block 1 split →
    // content-aware sees 4 columns whose real gutters sit at NON-uniform x
    // positions. A uniform 1×3 snap would slice through the wide middle block;
    // selecting the most-even subset of the DETECTED gutters keeps every block
    // intact (the phantom, being the least-even cut, is the one dropped).
    const { sheet, colors } = encodeUnevenRow([10, 16, 10], 1);

    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBe(4);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 3 } });
    expect(reconciled.cols).toBe(3);
    expect(reconciled.cells).toHaveLength(3);

    assertColorIsolation(sliceSheet(sheet, { expectedGrid: { rows: 1, cols: 3 } }), colors);
  });

  it('uniform-splits an under-segmented sheet up to the commanded count', () => {
    // Only 3 columns detected but 4 commanded, and no further gutters exist to
    // recover — fall back to a uniform split so the sheet still yields 4 cells
    // for human review (which rejects the sliced-through blocks).
    const sheet = encodeContentGrid(1, 3, {
      block: 8,
      gutter: 4,
      margin: 4,
      color: (_r, c) => ({ r: 200, g: 20 + c * 60, b: 40 }),
    });
    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBe(3);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(reconciled.cols).toBe(4);
    expect(reconciled.cells).toHaveLength(4);
  });

  it('emits the commanded count even for a genuinely wrong even layout (masking accepted)', () => {
    // 5 evenly-spaced blocks vs 4 commanded. There is no phantom to drop — this
    // is a real content error — but variance-select still returns the 4 most-even
    // cuts. We DO NOT gate on this: the sheet goes to human gallery review, which
    // rejects it. This test documents the accepted masking (product decision
    // 2026-07-07: human review, not the cell count, is the semantic gate).
    const sheet = encodeContentGrid(1, 5, {
      block: 8,
      gutter: 4,
      margin: 4,
      color: (_r, c) => ({ r: 40 + c * 40, g: 60, b: 200 }),
    });
    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBe(5);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(reconciled.cols).toBe(4);
    expect(reconciled.cells).toHaveLength(4);
  });

  it('reconciles BOTH axes independently when each is over-segmented', () => {
    // A well-formed 2×2, then punch a full-height bg stripe down the left column
    // AND a full-width bg stripe across the top row → content-aware over-segments
    // BOTH axes at once. Each axis must reconcile back to 2 (guards the latent
    // both-axes coupling bug where a spurious gap on one axis wrongly blocked
    // reconciliation of the other).
    const block = 12;
    const gutter = 6;
    const margin = 4;
    const width = margin * 2 + 2 * block + gutter;
    const height = width;
    const png = new PNG({ width, height });
    fillBg(png);
    const leftStripeX = margin + block / 2;
    const topStripeY = margin + block / 2;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const x0 = margin + c * (block + gutter);
        const y0 = margin + r * (block + gutter);
        const color = PALETTE[r * 2 + c]!;
        for (let y = y0; y < y0 + block; y++) {
          for (let x = x0; x < x0 + block; x++) {
            const inVertPhantom = c === 0 && x >= leftStripeX - 1 && x < leftStripeX + 1;
            const inHorizPhantom = r === 0 && y >= topStripeY - 1 && y < topStripeY + 1;
            if (inVertPhantom || inHorizPhantom) continue;
            const i = (y * width + x) * 4;
            png.data[i] = color.r;
            png.data[i + 1] = color.g;
            png.data[i + 2] = color.b;
          }
        }
      }
    }
    const sheet = PNG.sync.write(png);

    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBeGreaterThan(2);
    expect(bare.rows).toBeGreaterThan(2);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 2, cols: 2 } });
    expect(reconciled.cols).toBe(2);
    expect(reconciled.rows).toBe(2);
    expect(reconciled.cells).toHaveLength(4);
  });
});
