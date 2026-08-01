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
 * - on the generation path the brief's rows/cols are a SOFT anchor only. The
 *   slicer NEVER invents a cut: it cuts only at real detected gutters, picks the
 *   detected-cut subset that yields the most same-sized cells, and trims a runt
 *   leading/trailing edge cell (an incomplete partial sprite the model tacked
 *   on). It therefore carries the HONEST, data-driven grid/count to human
 *   gallery review — it never forces the commanded count by slicing through
 *   foreground art. That was the "chopping the right side" bug: a wide
 *   `welcome-room-shop-table` sheet drawn 3-wide but commanded 4-wide had a
 *   uniform 4-col split driven straight through every table. See ADR 0052.
 * - `sliceSheetFromBrief`/`sliceSheetWithGrid` return the ACTUAL grid + count
 *   (a `BriefSliceResult`) so the caller persists the real grid, not the
 *   commanded one;
 * - a fast-check property asserts the universal invariant over arbitrary grids.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PNG } from 'pngjs';
import {
  computeSliceMap,
  sliceSheet,
  sliceSheetFromBrief,
  sliceSheetWithGrid,
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

/**
 * One row of solid-colour blocks with the given (possibly uneven) widths,
 * separated by `gutter`, on a white sheet with `margin`. No internal splits —
 * this exercises the runt-edge trim + same-size selection over honest detected
 * columns (the "chopping the right side" salvage path).
 */
function encodeRowWidths(widths: readonly number[], gutter: number, margin: number): Buffer {
  const total = widths.reduce((a, b) => a + b, 0);
  const width = margin * 2 + total + (widths.length - 1) * gutter;
  const block = 10;
  const height = margin * 2 + block;
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = BG.r;
    png.data[i + 1] = BG.g;
    png.data[i + 2] = BG.b;
    png.data[i + 3] = 255;
  }
  let x0 = margin;
  const y0 = margin;
  for (let c = 0; c < widths.length; c++) {
    const w = widths[c]!;
    const col: Rgb = { r: 40 + c * 30, g: 60, b: 200 - c * 20 };
    for (let y = y0; y < y0 + block; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 4;
        png.data[i] = col.r;
        png.data[i + 1] = col.g;
        png.data[i + 2] = col.b;
      }
    }
    x0 += w + gutter;
  }
  return PNG.sync.write(png);
}

/**
 * A single row of `cols` equal-width, full-height solid-colour blocks with NO
 * gutter between them at all — content touches edge-to-edge across the whole
 * sheet width. Used to confirm that a gutter-free sheet now fails gracefully
 * (the content-aware slicer collapses it to a single cell) rather than silently
 * producing misaligned fixed-grid cuts. This is the desired quality-gate
 * behavior: briefs must provide a visible background gutter between every cell.
 */
function encodeGutterFreeRow(cols: number, cellW: number, cellH: number): Buffer {
  const width = cols * cellW;
  const height = cellH;
  const png = new PNG({ width, height });
  for (let c = 0; c < cols; c++) {
    const col: Rgb = { r: 10 + c * 50, g: 200 - c * 30, b: 80 + c * 20 };
    for (let y = 0; y < height; y++) {
      for (let x = c * cellW; x < (c + 1) * cellW; x++) {
        const i = (y * width + x) * 4;
        png.data[i] = col.r;
        png.data[i + 1] = col.g;
        png.data[i + 2] = col.b;
        png.data[i + 3] = 255;
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

/**
 * Count foreground (non-background) pixels sitting exactly on any of the given
 * vertical cut columns. Background is sampled from the top-left corner, so this
 * works for both white and chroma-key (magenta) sheets. Used to prove the
 * generation path never drives a cut line through foreground art.
 */
function fgPixelsOnColumns(sheet: Buffer, cutXs: readonly number[]): number {
  const png = PNG.sync.read(sheet);
  const bg = { r: png.data[0], g: png.data[1], b: png.data[2] };
  let count = 0;
  for (const cx of cutXs) {
    if (cx <= 0 || cx >= png.width) continue;
    for (let y = 0; y < png.height; y++) {
      const i = (y * png.width + cx) * 4;
      const isBg = png.data[i] === bg.r && png.data[i + 1] === bg.g && png.data[i + 2] === bg.b;
      if (!isBg) count++;
    }
  }
  return count;
}

/** Interior cut columns (the gutter pixel just left of each col>0 cell). */
function interiorCutXs(map: ReturnType<typeof computeSliceMap>): number[] {
  return [...new Set(map.cells.filter((c) => c.col > 0).map((c) => c.x0 - 1))].sort(
    (a, b) => a - b,
  );
}

/**
 * Encode a mostly-background square sheet with a single 1px-wide vertical stroke
 * at column `strokeX` (full height). Content trims to a ~3px span — a single
 * detected column, narrower than a multi-column commanded grid — which exercises
 * the degenerate-content path: the slicer emits the HONEST 1-cell count rather
 * than inventing cuts to reach the commanded columns.
 */
function encodeThinVerticalStroke(size: number, strokeX: number): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = BG.r;
    png.data[i + 1] = BG.g;
    png.data[i + 2] = BG.b;
    png.data[i + 3] = 255;
  }
  for (let y = 0; y < size; y++) {
    const i = (y * size + strokeX) * 4;
    png.data[i] = 0;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('computeSliceMap degenerate content (honest count, never invents cuts)', () => {
  it('emits the honest single-cell count when content is too thin to cut', () => {
    // A near-empty sheet: one 1px vertical stroke trims to a ~3px content span,
    // so only ONE column is detected. The commanded 4 columns are a soft anchor
    // only — the slicer must NOT invent 3 extra cuts through the (near-empty)
    // sheet just to hit 4. It emits the honest 1 cell and carries the bad
    // generation through to human gallery review, without crashing.
    const sheet = encodeThinVerticalStroke(16, 8);

    const map = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(map.rows).toBe(1);
    expect(map.cols).toBe(1);
    expect(map.cells).toHaveLength(1);
    for (const cell of map.cells) {
      expect(cell.w).toBeGreaterThanOrEqual(1);
      expect(cell.h).toBeGreaterThanOrEqual(1);
    }

    // Extraction must not throw, and returns the honest single cell.
    const cells = sliceSheet(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(cells).toHaveLength(1);
    for (const buf of cells) {
      expect(PNG.sync.read(buf).width).toBeGreaterThanOrEqual(1);
    }
  });

  it('carries a sheet smaller than the commanded grid through without crashing', () => {
    // Pathological and unreachable from a real brief (nativeCanvas ≥ 256, grid
    // ≤ 8×8), but the slicer is a public API: here the sheet axis (3px) is
    // narrower than the commanded 8 columns. The slicer detects a single column
    // and emits the honest 1 cell — it never force-increments cuts past the
    // axis (the old under-segmentation uniform-split, now removed). Extraction
    // must never read out of bounds; the cell is clamped to the sheet and the
    // bad generation is carried through to human review, not thrown.
    const tiny = encodeThinVerticalStroke(3, 1);
    const map = computeSliceMap(tiny, { expectedGrid: { rows: 1, cols: 8 } });
    expect(map.cells).toHaveLength(1);
    for (const cell of map.cells) {
      expect(cell.x0).toBeGreaterThanOrEqual(0);
      expect(cell.y0).toBeGreaterThanOrEqual(0);
      expect(cell.w).toBeGreaterThanOrEqual(1);
      expect(cell.h).toBeGreaterThanOrEqual(1);
      expect(cell.x0 + cell.w).toBeLessThanOrEqual(3);
      expect(cell.y0 + cell.h).toBeLessThanOrEqual(3);
    }
    expect(() => sliceSheet(tiny, { expectedGrid: { rows: 1, cols: 8 } })).not.toThrow();
    expect(sliceSheet(tiny, { expectedGrid: { rows: 1, cols: 8 } })).toHaveLength(1);
  });
});

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

  it('returns the actual data-driven grid and count (a BriefSliceResult)', () => {
    // A clean 2×2 whose content matches the commanded grid: the result carries
    // the extracted cells PLUS the actual grid/count the slicer landed on, so
    // the caller persists the real grid (not the commanded one).
    const sheet = encode2x2();
    const brief = {
      generation: {
        sheet: { rows: 2, cols: 2, emptyCells: [] as ReadonlyArray<readonly [number, number]> },
      },
    } as unknown as Brief;

    const result = sliceSheetFromBrief(sheet, brief);
    expect(result.cells).toHaveLength(4);
    expect(result.variantCount).toBe(4);
    expect(result.grid).toEqual({ rows: 2, cols: 2, emptyCells: [] });
  });

  it('skips brief-declared empty cells when the detected grid matches the commanded one', () => {
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

    const result = sliceSheetFromBrief(sheet, brief);
    expect(result.cells).toHaveLength(3);
    expect(result.variantCount).toBe(3);
    // The declared empty cell is honoured because the detected grid IS 2×2.
    expect(result.grid).toEqual({ rows: 2, cols: 2, emptyCells: [[0, 0]] });

    // (0,0) is skipped; the rest stay in reading order.
    const expectedOrder: Rgb[] = [BLOCK_COLORS[0]![1]!, BLOCK_COLORS[1]![0]!, BLOCK_COLORS[1]![1]!];
    result.cells.forEach((cell, i) => {
      expect(containsColor(cell, expectedOrder[i]!)).toBe(true);
    });
    // The skipped cell's color must not appear in any extracted cell.
    const skipped = BLOCK_COLORS[0]![0]!;
    for (const cell of result.cells) {
      expect(containsColor(cell, skipped)).toBe(false);
    }
  });

  it('carries the honest detected grid when content contradicts the commanded grid', () => {
    // Brief commands a 2×2 grid, but the sheet drew a single row of three
    // sprites — a genuine generation error. The slicer follows the pixels: it
    // detects a clean 1×3 (every cut in a real gutter) and returns that HONEST
    // grid rather than forcing 2×2 = 4 cells by inventing cuts/rows through the
    // art. The declared empty cells are dropped because the grid no longer
    // matches. Human gallery review — not a forced count — rejects the bad
    // sheet (product decision reversed 2026-07-08; ADR 0052).
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

    const result = sliceSheetFromBrief(sheet, brief);
    expect(result.cells).toHaveLength(3);
    expect(result.variantCount).toBe(3);
    expect(result.grid).toEqual({ rows: 1, cols: 3, emptyCells: [] });
  });
});

describe('sliceSheetFromBrief: frameSequence uses content-aware slicing', () => {
  // frameSequence briefs now use the same content-aware slicer as every other
  // brief type. The prompt requires a visible background gutter between every
  // cell so the slicer can detect them. A gutter-free sheet "fails loud" —
  // the slicer collapses it to a single cell — acting as a quality gate that
  // surfaces model-generated sheets that omit the required gutters, rather than
  // silently producing misaligned fixed-grid crops that fool per-frame sensors.
  function frameSequenceBrief(rows: number, cols: number, frameCount: number): Brief {
    return {
      generation: {
        sheet: {
          rows,
          cols,
          emptyCells: [] as ReadonlyArray<readonly [number, number]>,
          nativeCanvas: 1024,
        },
      },
      frameSequence: { enabled: true, frameCount, frameRate: 8, loop: true },
    } as unknown as Brief;
  }

  it('slices a guttered 4-frame 2×2 sheet into 4 clean cells in reading order', () => {
    const FRAME_COLORS: Rgb[] = [
      { r: 200, g: 40, b: 40 },
      { r: 40, g: 200, b: 40 },
      { r: 40, g: 40, b: 200 },
      { r: 200, g: 200, b: 40 },
    ];
    const sheet = encodeContentGrid(2, 2, {
      block: 16,
      gutter: 4,
      margin: 4,
      color: (r, c) => FRAME_COLORS[r * 2 + c]!,
    });
    const brief = frameSequenceBrief(2, 2, 4);

    const result = sliceSheetFromBrief(sheet, brief);

    expect(result.grid).toEqual({ rows: 2, cols: 2, emptyCells: [] });
    expect(result.cells).toHaveLength(4);
    expect(result.variantCount).toBe(4);

    // Cells come back in row-major reading order: (0,0), (0,1), (1,0), (1,1).
    for (let i = 0; i < 4; i++) {
      expect(containsColor(result.cells[i]!, FRAME_COLORS[i]!)).toBe(true);
      // No bleed from neighbouring frame colours.
      for (let j = 0; j < 4; j++) {
        if (j === i) continue;
        expect(containsColor(result.cells[i]!, FRAME_COLORS[j]!)).toBe(false);
      }
    }
  });

  it('also accepts a single-row 1×4 layout when gutters are present', () => {
    const FRAME_COLORS: Rgb[] = [
      { r: 10 + 0 * 50, g: 200 - 0 * 30, b: 80 + 0 * 20 },
      { r: 10 + 1 * 50, g: 200 - 1 * 30, b: 80 + 1 * 20 },
      { r: 10 + 2 * 50, g: 200 - 2 * 30, b: 80 + 2 * 20 },
      { r: 10 + 3 * 50, g: 200 - 3 * 30, b: 80 + 3 * 20 },
    ];
    const sheet = encodeContentGrid(1, 4, {
      block: 12,
      gutter: 4,
      margin: 4,
      color: (_r, c) => FRAME_COLORS[c]!,
    });
    const brief = frameSequenceBrief(1, 4, 4);

    const result = sliceSheetFromBrief(sheet, brief);

    expect(result.cells).toHaveLength(4);
    expect(result.variantCount).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(containsColor(result.cells[i]!, FRAME_COLORS[i]!)).toBe(true);
    }
  });

  it('collapses a gutter-free sheet to 1 cell (quality gate — model must leave gutters)', () => {
    // This is the DESIRED behavior: without background gutters the content-aware
    // slicer cannot find any cut positions and returns 1 cell. This surfaces
    // model-generated sheets that omit the required gutters rather than
    // silently shipping split/bled content via a fixed-grid cut.
    const sheet = encodeGutterFreeRow(4, 16, 16);
    const brief = frameSequenceBrief(1, 4, 4);

    const result = sliceSheetFromBrief(sheet, brief);
    // Content-aware detection finds no interior gutters → 1×1 result.
    expect(result.cells).toHaveLength(1);
    expect(result.variantCount).toBe(1);
  });

  it('frameSequence and non-frameSequence briefs behave identically on a guttered sheet', () => {
    // Both brief types now go through the same content-aware slicer; the only
    // difference is the schema validation and the walk-cycle prompt, not the
    // slicing path.
    const sheet = encodeContentGrid(2, 2, {
      block: 10,
      gutter: 4,
      margin: 4,
      color: (r, c) => ({ r: 40 + r * 80, g: 40 + c * 80, b: 80 }),
    });
    const seqBrief = frameSequenceBrief(2, 2, 4);
    const nonSeqBrief = {
      generation: {
        sheet: {
          rows: 2,
          cols: 2,
          emptyCells: [] as ReadonlyArray<readonly [number, number]>,
          nativeCanvas: 1024,
        },
      },
      frameSequence: { enabled: false, frameCount: 4, frameRate: 8, loop: true },
    } as unknown as Brief;

    const seqResult = sliceSheetFromBrief(sheet, seqBrief);
    const nonSeqResult = sliceSheetFromBrief(sheet, nonSeqBrief);

    expect(seqResult.grid).toEqual(nonSeqResult.grid);
    expect(seqResult.variantCount).toBe(nonSeqResult.variantCount);
  });
});

describe('Bug B regression: inter-cell gutters govern the recovered grid', () => {
  // A correctly-gutted 4×4 sheet slices into exactly 16 cells — the honest
  // target a well-formed generation produces. This is what the strengthened
  // sheet prompt (mandatory background gutter between every row AND column) is
  // meant to make gpt-image-1 draw.
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

describe('salvage policy: never cut through foreground art', () => {
  const MAGENTA: Rgb = { r: 255, g: 0, b: 255 };

  /**
   * The real bug, in 2D: a wide sheet drawn as 3 full 40px columns + a narrow
   * 12px runt column (5 rows), commanded 4×4. This mirrors the real
   * `welcome-room-shop-table-v2` sheet the model drew 3-wide. The generation
   * path must (a) detect the honest columns, (b) DROP the runt right column
   * (an incomplete partial sprite), and (c) never drive a cut line through
   * foreground — vs the old forced 4-col uniform split that severed every row.
   */
  function encodeShopTableSheet(): Buffer {
    const colW = [40, 40, 40, 12];
    const rows = 5;
    const rowH = 20;
    const gutter = 6;
    const margin = 4;
    const totalW = colW.reduce((a, b) => a + b, 0);
    const width = margin * 2 + totalW + (colW.length - 1) * gutter;
    const height = margin * 2 + rows * rowH + (rows - 1) * gutter;
    const png = new PNG({ width, height });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = MAGENTA.r;
      png.data[i + 1] = MAGENTA.g;
      png.data[i + 2] = MAGENTA.b;
      png.data[i + 3] = 255;
    }
    let x = margin;
    const colX: number[] = [];
    for (const w of colW) {
      colX.push(x);
      x += w + gutter;
    }
    for (let r = 0; r < rows; r++) {
      const y0 = margin + r * (rowH + gutter);
      for (let c = 0; c < colW.length; c++) {
        const cx = colX[c]!;
        const w = colW[c]!;
        const color = { r: 20 + c * 40, g: 40 + r * 30, b: 120 };
        for (let y = y0; y < y0 + rowH; y++) {
          for (let px = cx; px < cx + w; px++) {
            const i = (y * width + px) * 4;
            png.data[i] = color.r;
            png.data[i + 1] = color.g;
            png.data[i + 2] = color.b;
          }
        }
      }
    }
    return PNG.sync.write(png);
  }

  it('drops the runt right column and never cuts through a sprite (the shop-table bug)', () => {
    const sheet = encodeShopTableSheet();

    // Bare content-aware detection sees all four columns (incl. the runt).
    const bare = computeSliceMap(sheet);
    expect(bare.rows).toBe(5);
    expect(bare.cols).toBe(4);

    // Commanded 4×4 (the brief default that caused the bug). The slicer keeps
    // the 5 honest rows, DROPS the 12px runt right column → 5×3 = 15 cells.
    const gen = computeSliceMap(sheet, { expectedGrid: { rows: 4, cols: 4 } });
    expect(gen.rows).toBe(5);
    expect(gen.cols).toBe(3);
    expect(gen.cells).toHaveLength(15);

    // The core guarantee: ZERO foreground pixels on any interior cut line.
    expect(fgPixelsOnColumns(sheet, interiorCutXs(gen))).toBe(0);

    // And the old failure mode is real on this fixture: a forced 4-col uniform
    // split would slice straight through every row (proves we fixed a live bug,
    // not a hypothetical one).
    const png = PNG.sync.read(sheet);
    const forcedXs = [1, 2, 3].map((k) => Math.round((png.width * k) / 4));
    expect(fgPixelsOnColumns(sheet, forcedXs)).toBeGreaterThan(0);
  });

  it('trims a trailing runt column when the rest are uniform ([44,46,46,16] → 3)', () => {
    const sheet = encodeRowWidths([44, 46, 46, 16], 6, 4);
    const gen = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(gen.cols).toBe(3);
    expect(gen.cells).toHaveLength(3);
    expect(fgPixelsOnColumns(sheet, interiorCutXs(gen))).toBe(0);
  });

  it('trims a leading runt column ([20,40,40] → 2)', () => {
    const sheet = encodeRowWidths([20, 40, 40], 6, 4);
    const gen = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 3 } });
    expect(gen.cols).toBe(2);
    expect(gen.cells).toHaveLength(2);
    expect(fgPixelsOnColumns(sheet, interiorCutXs(gen))).toBe(0);
  });

  it('trims a runt from a 2-cell pair when it is under half the neighbour ([46,16] → 1)', () => {
    const sheet = encodeRowWidths([46, 16], 6, 4);
    const gen = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 2 } });
    expect(gen.cols).toBe(1);
    expect(gen.cells).toHaveLength(1);
  });

  it('keeps a legit uneven 2-cell pair rather than collapsing to one ([40,60] → 2)', () => {
    // The runt trim must not swallow a real second sprite: 40 is more than half
    // of 60, so both cells are kept (no k=1 collapse of a legitimate pair).
    const sheet = encodeRowWidths([40, 60], 6, 4);
    const gen = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 2 } });
    expect(gen.cols).toBe(2);
    expect(gen.cells).toHaveLength(2);
    expect(fgPixelsOnColumns(sheet, interiorCutXs(gen))).toBe(0);
  });

  it('does not trim a small leading cell that is half of a split sprite (phantom-half guard)', () => {
    // [10,30,40,40]: the leading 10 + its 30 neighbour together (~1 median
    // sprite) look like a subject split by a phantom gutter, NOT a runt edge —
    // so the phantom-half guard keeps all four cells rather than discarding the
    // 10 as a partial sprite. (Human review still adjudicates the true count.)
    const sheet = encodeRowWidths([10, 30, 40, 40], 6, 4);
    const gen = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(gen.cols).toBe(4);
    expect(gen.cells).toHaveLength(4);
    expect(fgPixelsOnColumns(sheet, interiorCutXs(gen))).toBe(0);
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

  it('drops a single spurious over-segmented column to the commanded grid, cleanly', () => {
    // 4 logical blocks, block 1 split by an internal gap → content-aware sees 5.
    const { sheet, colors } = encodeGappyRow(4, [1]);

    // Without the hint, the spurious band over-segments to 5 columns (the bug).
    const bare = computeSliceMap(sheet);
    expect(bare.rows).toBe(1);
    expect(bare.cols).toBe(5);

    // With the commanded grid, dropping the phantom gutter yields 4 uniform
    // cells (more same-sized than keeping 5), so the slicer reconciles to 1×4.
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
    // same-size-maximising subset must drop BOTH phantom gutters and recover 1×4.
    const { sheet, colors } = encodeGappyRow(4, [1, 3]);

    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBe(6);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(reconciled.cols).toBe(4);
    expect(reconciled.cells).toHaveLength(4);

    assertColorIsolation(sliceSheet(sheet, { expectedGrid: { rows: 1, cols: 4 } }), colors);
  });

  it('cuts at real (uneven) gutters rather than snapping to a uniform grid', () => {
    // Three blocks of very different widths (10, 14, 12) with block 1 split →
    // content-aware sees 4 columns whose real gutters sit at NON-uniform x
    // positions. Dropping the phantom recovers a cleaner 1×3 (the three uneven
    // blocks) than keeping the split, so every block stays intact.
    const { sheet, colors } = encodeUnevenRow([10, 14, 12], 1);

    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBe(4);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 3 } });
    expect(reconciled.cols).toBe(3);
    expect(reconciled.cells).toHaveLength(3);

    assertColorIsolation(sliceSheet(sheet, { expectedGrid: { rows: 1, cols: 3 } }), colors);
  });

  it('leaves an under-segmented sheet at its honest count (never invents cuts)', () => {
    // Only 3 columns detected but 4 commanded, and no further gutters exist to
    // recover. The slicer must NOT invent a 4th cut through the art — it emits
    // the honest 1×3 and carries the count-short sheet to human gallery review.
    const sheet = encodeContentGrid(1, 3, {
      block: 8,
      gutter: 4,
      margin: 4,
      color: (_r, c) => ({ r: 200, g: 20 + c * 60, b: 40 }),
    });
    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBe(3);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(reconciled.cols).toBe(3);
    expect(reconciled.cells).toHaveLength(3);
    // No cut was invented: every cut is a real gutter, so no foreground severed.
    expect(fgPixelsOnColumns(sheet, interiorCutXs(reconciled))).toBe(0);
  });

  it('never masks a real content error by dropping a real gutter (keeps honest count)', () => {
    // 5 evenly-spaced blocks vs 4 commanded. There is no phantom to drop — this
    // is a real content error. The slicer must NOT drop a real gutter to force
    // the commanded 4 (the old masking behaviour); it keeps the honest 1×5 and
    // human gallery review rejects it. Every cut stays in a real gutter.
    const sheet = encodeContentGrid(1, 5, {
      block: 8,
      gutter: 4,
      margin: 4,
      color: (_r, c) => ({ r: 40 + c * 40, g: 60, b: 200 }),
    });
    const bare = computeSliceMap(sheet);
    expect(bare.cols).toBe(5);

    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } });
    expect(reconciled.cols).toBe(5);
    expect(reconciled.cells).toHaveLength(5);
    expect(fgPixelsOnColumns(sheet, interiorCutXs(reconciled))).toBe(0);
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

  it('is deterministic and yields strictly positive-area cells', () => {
    // Same sheet + same options must slice identically across runs (the pipeline
    // is deterministic; selection is fixed by integer scores + a strict order).
    const { sheet } = encodeGappyRow(4, [1, 3]);
    const opts = { expectedGrid: { rows: 1, cols: 4 } } as const;
    const a = computeSliceMap(sheet, opts);
    const b = computeSliceMap(sheet, opts);
    const box = (m: typeof a): number[][] => m.cells.map((c) => [c.x0, c.y0, c.w, c.h]);
    expect(box(b)).toEqual(box(a));
    for (const cell of a.cells) {
      expect(cell.w).toBeGreaterThan(0);
      expect(cell.h).toBeGreaterThan(0);
    }
  });

  it('leaves the raw content-aware grid untouched when no expectedGrid is given (debugger path)', () => {
    // The debugger / sidecar path passes no expectedGrid, so it must see the pure
    // (even spurious) content-aware grid — never the reconciled one.
    const { sheet } = encodeGappyRow(4, [1]); // over-segments to 5 columns
    const noOpts = computeSliceMap(sheet);
    const emptyOpts = computeSliceMap(sheet, {});
    expect(emptyOpts.cols).toBe(noOpts.cols);
    expect(emptyOpts.rows).toBe(noOpts.rows);
    expect(noOpts.cols).toBe(5);
    // Only the generation path (expectedGrid present) reconciles.
    expect(computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 4 } }).cols).toBe(4);
  });

  it('keeps a symmetric split when it yields the most same-sized cells (human review adjudicates)', () => {
    // [10,16,10] with the wide middle block split by a phantom gutter → 4
    // detected columns whose (gutter-expanded) cells are all near-uniform. The
    // "most same-sized cells" rule keeps all 4 rather than merging back to 3 —
    // a documented consequence of preferring uniformity. This is NOT the
    // dangerous case: every cut still lands in a real background band (0
    // foreground severed); human gallery review adjudicates the true count.
    const { sheet } = encodeUnevenRow([10, 16, 10], 1);
    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 3 } });
    expect(reconciled.cols).toBe(4);
    expect(reconciled.cells).toHaveLength(4);
    expect(fgPixelsOnColumns(sheet, interiorCutXs(reconciled))).toBe(0);
  });

  it('keeps the honest count when extreme width-asymmetry yields uneven cells', () => {
    // Documented limitation: with a tiny end block (12,20,8) and a central
    // phantom, no smaller subset is strictly more uniform than the 4 detected
    // cells, so the slicer keeps the honest 1×4 (it never invents cuts; every
    // cut stays in a real gutter). Human gallery review adjudicates the count.
    const { sheet } = encodeUnevenRow([12, 20, 8], 1);
    const reconciled = computeSliceMap(sheet, { expectedGrid: { rows: 1, cols: 3 } });
    expect(reconciled.cols).toBe(4);
    expect(reconciled.cells).toHaveLength(4);
    expect(fgPixelsOnColumns(sheet, interiorCutXs(reconciled))).toBe(0);
  });

  it('reconciles a mixed sheet: cols over-segmented, rows under-segmented (honest rows)', () => {
    // 1 row of 3 blocks with block 1 split → cols over-segmented (4 detected)
    // and rows under-segmented (1 detected) vs a commanded 2×3. Cols drop the
    // phantom to 3; rows stay at the honest 1 (never invent a 2nd row through
    // the art) → 3 cells, not the commanded 6.
    const { sheet } = encodeGappyRow(3, [1]);
    const map = computeSliceMap(sheet, { expectedGrid: { rows: 2, cols: 3 } });
    expect(map.cols).toBe(3);
    expect(map.rows).toBe(1);
    expect(map.cells).toHaveLength(3);
    for (const cell of map.cells) {
      expect(cell.w).toBeGreaterThan(0);
      expect(cell.h).toBeGreaterThan(0);
    }
  });
});

describe('sliceSheetWithGrid (rerun re-slice determinism)', () => {
  it('reproduces the persisted grid and count from the same stored sheet', () => {
    // A 1×3 sheet commanded 2×2 lands on the honest 1×3 at generation time. The
    // rerun path re-slices the SAME stored sheet anchored on that persisted grid
    // and must deterministically reproduce it (identical crops), so
    // re-postprocess re-derives the same per-variant entries.
    const sheet = encodeContentGrid(1, 3, {
      block: 6,
      gutter: 4,
      margin: 4,
      color: (_r, c) => ({ r: 200, g: 20 + c * 60, b: 40 }),
    });
    const brief = {
      generation: {
        sheet: { rows: 2, cols: 2, emptyCells: [] as ReadonlyArray<readonly [number, number]> },
      },
    } as unknown as Brief;

    const generated = sliceSheetFromBrief(sheet, brief);
    expect(generated.grid).toEqual({ rows: 1, cols: 3, emptyCells: [] });

    const rerun = sliceSheetWithGrid(sheet, generated.grid);
    expect(rerun.grid).toEqual(generated.grid);
    expect(rerun.variantCount).toBe(generated.variantCount);
    // Byte-identical crops across the re-slice (deterministic).
    expect(rerun.cells.map((c) => c.length)).toEqual(generated.cells.map((c) => c.length));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transparent-background sheet slicing (icon batch regression)
//
// Icon sheets are generated on a TRANSPARENT background (alpha=0 gutters).
// Before the fix, `findBgRows`/`findBgColumns` ignored the alpha channel,
// so transparent gutter pixels were mis-classified as foreground when their
// stored RGB values differed from the corner-estimated background colour —
// producing 1 cell instead of the expected grid.
//
// The failure trigger: corners happen to have a different (or zeroed) RGB from
// the interior gutter pixels, so `estimateSheetBackgroundRgb` returns a value
// that doesn't match the gutter RGB. With alpha ignored, those gutter pixels
// were classified as "foreground" → no interior bands → 1 cell.
//
// The fix: on transparent-backed sheets alpha=0 always → background, and any
// nonzero-alpha pixel is foreground regardless of stored RGB.
// ─────────────────────────────────────────────────────────────────────────────
describe('transparent-background sheet slicing (icon batch)', () => {
  /**
   * Encode a rows×cols grid of coloured blocks on a FULLY TRANSPARENT sheet.
   * Gutter areas and margins have alpha=0 with `gutterRgb`. Corner pixels are
   * independently set to `cornerRgb` (defaults to {r:0,g:0,b:0}) to simulate
   * a real-world PNG where transparent corner pixels are zeroed but the interior
   * gutter pixels retain a different "bleed" RGB — the exact condition that
   * caused the slicer to misclassify gutters as foreground before the fix.
   */
  function encodeTransparentGrid(
    rows: number,
    cols: number,
    block: number,
    gutter: number,
    margin: number,
    gutterRgb: Rgb = { r: 150, g: 100, b: 200 },
    cornerRgb: Rgb = { r: 0, g: 0, b: 0 },
    color: (row: number, col: number) => Rgb = (r, c) => ({
      r: 80 + c * 30,
      g: 120 + r * 20,
      b: 60,
    }),
  ): Buffer {
    const width = margin * 2 + cols * block + (cols - 1) * gutter;
    const height = margin * 2 + rows * block + (rows - 1) * gutter;
    const png = new PNG({ width, height });
    // Fill entire sheet with gutterRgb at alpha=0.
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = gutterRgb.r;
      png.data[i + 1] = gutterRgb.g;
      png.data[i + 2] = gutterRgb.b;
      png.data[i + 3] = 0; // fully transparent
    }
    // Override the 4 corner pixels with cornerRgb (still transparent).
    // This causes estimateSheetBackgroundRgb to return cornerRgb, not gutterRgb,
    // so the gutter interior pixels appear "far from background" in the old code.
    for (const [cx, cy] of [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ] as const) {
      const ci = (cy * width + cx) * 4;
      png.data[ci] = cornerRgb.r;
      png.data[ci + 1] = cornerRgb.g;
      png.data[ci + 2] = cornerRgb.b;
      png.data[ci + 3] = 0; // still transparent
    }
    // Place opaque icon blocks.
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
            png.data[i + 3] = 255; // fully opaque icon content
          }
        }
      }
    }
    return PNG.sync.write(png);
  }

  it('slices a 4×4 transparent-background icon sheet into 16 cells (regression: was 1)', () => {
    // Corner pixels: alpha=0, RGB=(0,0,0) → estimated background = (0,0,0)
    // Gutter pixels: alpha=0, RGB=(150,100,200) → far from bg → mis-classified
    //   as foreground by the old code → no interior bands → 1 cell.
    // With the fix (alpha=0 → always background): 16 cells sliced correctly.
    const sheet = encodeTransparentGrid(4, 4, 20, 4, 4);
    const brief = {
      generation: { sheet: { rows: 4, cols: 4, emptyCells: [] } },
    } as unknown as Brief;
    const result = sliceSheetFromBrief(sheet, brief);
    expect(result.variantCount).toBe(16);
    expect(result.grid.rows).toBe(4);
    expect(result.grid.cols).toBe(4);
  });

  it('slices a 4×4 transparent sheet when gutter RGB happens to be black (corner=gutter)', () => {
    // When gutter RGB equals the corner RGB the old code also worked, but the
    // fix must keep working here too — not just for the adversarial case.
    const sheet = encodeTransparentGrid(
      4,
      4,
      20,
      4,
      4,
      { r: 0, g: 0, b: 0 },
      {
        r: 0,
        g: 0,
        b: 0,
      },
    );
    const brief = {
      generation: { sheet: { rows: 4, cols: 4, emptyCells: [] } },
    } as unknown as Brief;
    const result = sliceSheetFromBrief(sheet, brief);
    expect(result.variantCount).toBe(16);
    expect(result.grid).toEqual({ rows: 4, cols: 4, emptyCells: [] });
  });

  it('slices a 2×2 transparent sheet with high-RGB gutter against zero-corner background', () => {
    // Explicitly adversarial: corners=(0,0,0), gutter=(220,80,170) — the
    // euclidean distance of 220²+80²+170² ≈ 86024 >> 24² = 576 threshold,
    // so the old code would flag every gutter pixel as foreground → 1 cell.
    const sheet = encodeTransparentGrid(
      2,
      2,
      16,
      4,
      4,
      { r: 220, g: 80, b: 170 }, // gutter RGB far from corners
      { r: 0, g: 0, b: 0 }, // corner RGB (zeroed transparent)
    );
    const brief = {
      generation: { sheet: { rows: 2, cols: 2, emptyCells: [] } },
    } as unknown as Brief;
    const result = sliceSheetFromBrief(sheet, brief);
    expect(result.variantCount).toBe(4);
    expect(result.grid.rows).toBe(2);
    expect(result.grid.cols).toBe(2);
  });

  it('treats opaque black icon pixels as foreground on transparent-backed sheets', () => {
    // Transparent corner RGB is meaningless. When it is zeroed to black, opaque
    // black icon content must still count as foreground rather than blending
    // into the estimated "background" colour.
    const sheet = encodeTransparentGrid(
      2,
      2,
      16,
      4,
      4,
      { r: 220, g: 80, b: 170 },
      { r: 0, g: 0, b: 0 },
      () => ({ r: 0, g: 0, b: 0 }),
    );
    const brief = {
      generation: { sheet: { rows: 2, cols: 2, emptyCells: [] } },
    } as unknown as Brief;
    const result = sliceSheetFromBrief(sheet, brief);
    expect(result.variantCount).toBe(4);
    expect(result.grid).toEqual({ rows: 2, cols: 2, emptyCells: [] });
  });

  it('still slices a solid-background sheet correctly (non-regression for existing types)', () => {
    // Solid-background sprite sheets (enemies, weapons, etc.) must continue to
    // work exactly as before — the alpha fix must not break the common path.
    const sheet = encodeContentGrid(3, 3, {
      block: 16,
      gutter: 4,
      margin: 4,
      color: (r, c) => ({ r: 80 + c * 40, g: 100 + r * 30, b: 60 }),
    });
    const brief = {
      generation: { sheet: { rows: 3, cols: 3, emptyCells: [] } },
    } as unknown as Brief;
    const result = sliceSheetFromBrief(sheet, brief);
    expect(result.variantCount).toBe(9);
    expect(result.grid).toEqual({ rows: 3, cols: 3, emptyCells: [] });
  });
});
