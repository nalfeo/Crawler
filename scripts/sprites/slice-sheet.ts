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
 * nearest-neighbor resample to each brief's target output size (default 64×64).
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
  readonly autoNudge?: {
    readonly enabled?: boolean;
    readonly maxVerticalShiftPx?: number;
    readonly backgroundDistanceThreshold?: number;
    readonly edgeBandPx?: number;
  };
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
  const autoNudge = options.autoNudge;
  const rowOffsets =
    autoNudge?.enabled === true
      ? inferRowOffsets(
          sheet,
          rows,
          cellH,
          autoNudge.maxVerticalShiftPx ?? 12,
          autoNudge.backgroundDistanceThreshold ?? 24,
        )
      : new Array(rows).fill(0);
  const colOffsets =
    autoNudge?.enabled === true
      ? inferColOffsets(
          sheet,
          cols,
          cellW,
          Math.max(2, Math.floor((autoNudge.maxVerticalShiftPx ?? 12) / 2)),
          autoNudge.backgroundDistanceThreshold ?? 24,
        )
      : new Array(cols).fill(0);

  const out: Buffer[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (emptyKeys.has(`${r},${c}`)) continue;
      const x0 = clamp(c * cellW + (colOffsets[c] ?? 0), 0, sheet.width - cellW);
      const y0 = clamp(r * cellH + (rowOffsets[r] ?? 0), 0, sheet.height - cellH);
      out.push(extractCell(sheet, x0, y0, cellW, cellH));
    }
  }
  return out;
}

/**
 * Convenience wrapper that pulls grid shape and empty cells from a brief.
 */
export function sliceSheetFromBrief(sheetPng: Buffer, brief: Brief): Buffer[] {
  const nudgeEnabled = brief.type === 'character' || brief.type === 'enemy';
  return sliceSheet(sheetPng, {
    rows: brief.generation.sheet.rows,
    cols: brief.generation.sheet.cols,
    emptyCells: brief.generation.sheet.emptyCells,
    autoNudge: nudgeEnabled
      ? {
          enabled: true,
          maxVerticalShiftPx: 12,
          backgroundDistanceThreshold: 24,
          edgeBandPx: 2,
        }
      : undefined,
  });
}

function extractCell(sheet: PNG, x0: number, y0: number, width: number, height: number): Buffer {
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

function inferRowOffsets(
  sheet: PNG,
  rows: number,
  cellH: number,
  maxShift: number,
  bgThreshold: number,
): number[] {
  const bg = estimateSheetBackgroundRgb(sheet);
  const out: number[] = [];
  for (let r = 0; r < rows; r++) {
    const baseY = r * cellH;
    let bestOffset = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let offset = -maxShift; offset <= maxShift; offset++) {
      const y0 = baseY + offset;
      if (y0 < 0 || y0 + cellH > sheet.height) continue;
      const top = rowForegroundCount(sheet, y0, bg, bgThreshold);
      const bottom = rowForegroundCount(sheet, y0 + cellH - 1, bg, bgThreshold);
      const score = top + bottom * 2;
      const abs = Math.abs(offset);
      const bestAbs = Math.abs(bestOffset);
      if (score < bestScore || (score === bestScore && abs < bestAbs)) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    out.push(bestOffset);
  }
  return out;
}

function inferColOffsets(
  sheet: PNG,
  cols: number,
  cellW: number,
  maxShift: number,
  bgThreshold: number,
): number[] {
  const bg = estimateSheetBackgroundRgb(sheet);
  const out: number[] = [];
  for (let c = 0; c < cols; c++) {
    const baseX = c * cellW;
    let bestOffset = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let offset = -maxShift; offset <= maxShift; offset++) {
      const x0 = baseX + offset;
      if (x0 < 0 || x0 + cellW > sheet.width) continue;
      const left = colForegroundCount(sheet, x0, bg, bgThreshold);
      const right = colForegroundCount(sheet, x0 + cellW - 1, bg, bgThreshold);
      const score = left + right;
      const abs = Math.abs(offset);
      const bestAbs = Math.abs(bestOffset);
      if (score < bestScore || (score === bestScore && abs < bestAbs)) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    out.push(bestOffset);
  }
  return out;
}

function estimateSheetBackgroundRgb(sheet: PNG): readonly [number, number, number] {
  const corners: readonly (readonly [number, number])[] = [
    [0, 0],
    [sheet.width - 1, 0],
    [0, sheet.height - 1],
    [sheet.width - 1, sheet.height - 1],
  ] as const;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [x, y] of corners) {
    const idx = (y * sheet.width + x) * 4;
    r += sheet.data[idx] ?? 0;
    g += sheet.data[idx + 1] ?? 0;
    b += sheet.data[idx + 2] ?? 0;
  }
  return [Math.round(r / 4), Math.round(g / 4), Math.round(b / 4)] as const;
}

function rowForegroundCount(
  sheet: PNG,
  y: number,
  bg: readonly [number, number, number],
  threshold: number,
): number {
  if (y < 0 || y >= sheet.height) return Number.POSITIVE_INFINITY;
  let foreground = 0;
  for (let x = 0; x < sheet.width; x++) {
    const idx = (y * sheet.width + x) * 4;
    const r = sheet.data[idx] ?? 0;
    const g = sheet.data[idx + 1] ?? 0;
    const b = sheet.data[idx + 2] ?? 0;
    if (rgbDistanceSq(r, g, b, bg[0], bg[1], bg[2]) > threshold * threshold) foreground++;
  }
  return foreground;
}

function colForegroundCount(
  sheet: PNG,
  x: number,
  bg: readonly [number, number, number],
  threshold: number,
): number {
  if (x < 0 || x >= sheet.width) return Number.POSITIVE_INFINITY;
  let foreground = 0;
  for (let y = 0; y < sheet.height; y++) {
    const idx = (y * sheet.width + x) * 4;
    const r = sheet.data[idx] ?? 0;
    const g = sheet.data[idx + 1] ?? 0;
    const b = sheet.data[idx + 2] ?? 0;
    if (rgbDistanceSq(r, g, b, bg[0], bg[1], bg[2]) > threshold * threshold) foreground++;
  }
  return foreground;
}

function rgbDistanceSq(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
