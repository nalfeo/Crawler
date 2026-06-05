import { PNG } from 'pngjs';
import type { Brief } from './brief-schema.js';

/**
 * Pure sheet slicer.
 *
 * The Azure provider returns one big PNG containing N variants laid out in a
 * regular `rows x cols` grid (reading order: left-to-right, top-to-bottom).
 * `sliceSheet` splits that sheet into N individual PNG buffers at the cell's
 * *native* resolution — before any postprocessing. The downstream postprocessor
 * (Phase 1) is responsible for quantising, cropping, background removal, and
 * nearest-neighbor downscale to 16×16.
 *
 * Why slice before postprocessing rather than passing the whole sheet through
 * the existing postprocessor: the sheet's background-removal floodfill would
 * leak across cells if a cell happens to share a corner color with another
 * cell. Slicing first guarantees each cell is processed in isolation.
 *
 * Sheets where (sheetWidth %% cols !== 0) or (sheetHeight %% rows !== 0)
 * are rejected. The model is told to use equal cells in the prompt, and a
 * non-divisible sheet usually means the provider gave us an off-spec image
 * — better to fail loudly than to silently produce mis-aligned cells.
 */

export interface SliceOptions {
  readonly rows: number;
  readonly cols: number;
  readonly emptyCells?: ReadonlyArray<readonly [number, number]>;
}

/**
 * Slice a sheet into individual cell PNGs.
 *
 * Returns one buffer per *non-empty* cell, in reading order (row-major,
 * left-to-right top-to-bottom). Empty cells are skipped — the caller gets
 * exactly `rows * cols - emptyCells.length` outputs.
 */
export function sliceSheet(sheetPng: Buffer, options: SliceOptions): Buffer[] {
  const { rows, cols } = options;
  if (rows < 1 || cols < 1) {
    throw new Error(`sliceSheet: rows and cols must be >= 1 (got ${rows}x${cols})`);
  }
  const emptyCells = options.emptyCells ?? [];
  const emptyKeys = new Set(emptyCells.map(([r, c]) => `${r},${c}`));

  const sheet = PNG.sync.read(sheetPng);
  if (sheet.width % cols !== 0 || sheet.height % rows !== 0) {
    throw new Error(
      `sliceSheet: sheet ${sheet.width}x${sheet.height} is not evenly divisible into a ${rows}x${cols} grid`,
    );
  }
  const cellW = sheet.width / cols;
  const cellH = sheet.height / rows;

  const out: Buffer[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (emptyKeys.has(`${r},${c}`)) continue;
      out.push(extractCell(sheet, c * cellW, r * cellH, cellW, cellH));
    }
  }
  return out;
}

/**
 * Convenience wrapper that pulls grid shape and empty cells from a brief.
 */
export function sliceSheetFromBrief(sheetPng: Buffer, brief: Brief): Buffer[] {
  return sliceSheet(sheetPng, {
    rows: brief.generation.sheet.rows,
    cols: brief.generation.sheet.cols,
    emptyCells: brief.generation.sheet.emptyCells,
  });
}

function extractCell(
  sheet: PNG,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Buffer {
  const cell = new PNG({ width, height });
  // Copy row-by-row from the sheet into the cell. We do this manually rather
  // than using pngjs's bitblt because bitblt's signature differs subtly
  // between versions and the manual copy is trivially correct and fast.
  for (let y = 0; y < height; y++) {
    const srcStart = ((y0 + y) * sheet.width + x0) * 4;
    const srcEnd = srcStart + width * 4;
    const dstStart = y * width * 4;
    sheet.data.copy(cell.data, dstStart, srcStart, srcEnd);
  }
  return PNG.sync.write(cell);
}
