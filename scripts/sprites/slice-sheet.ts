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
  };
}

export interface SliceBbox {
  /** 0-based variant index in reading order, excluding empty cells. -1 for empty cells. */
  readonly index: number;
  readonly row: number;
  readonly col: number;
  /** Actual top-left x after autoNudge + clamp. */
  readonly x0: number;
  /** Actual top-left y after autoNudge + clamp. */
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  readonly empty: boolean;
}

export interface SliceMap {
  readonly sheetW: number;
  readonly sheetH: number;
  readonly rows: number;
  readonly cols: number;
  /** Nominal cell width (= sheetW / cols), before nudge. */
  readonly cellW: number;
  /** Nominal cell height (= sheetH / rows), before nudge. */
  readonly cellH: number;
  /** Per-row vertical offset applied by autoNudge (0 = no nudge). */
  readonly rowOffsets: readonly number[];
  /** Per-column horizontal offset applied by autoNudge (0 = no nudge). */
  readonly colOffsets: readonly number[];
  /** Every cell in reading order, including empty cells. */
  readonly cells: readonly SliceBbox[];
}

/**
 * Compute the actual bounding boxes for every cell in the sheet without
 * extracting pixel data. Useful for visualisation (the debugger draws
 * these exact rectangles rather than a uniform grid).
 */
export function computeSliceMap(sheetPng: Buffer, options: SliceOptions): SliceMap {
  const { rows, cols } = options;
  if (rows < 1 || cols < 1) {
    throw new Error(`computeSliceMap: rows and cols must be >= 1 (got ${rows}x${cols})`);
  }
  const sheet = PNG.sync.read(sheetPng);
  if (sheet.width % cols !== 0 || sheet.height % rows !== 0) {
    throw new Error(
      `computeSliceMap: sheet ${sheet.width}x${sheet.height} is not evenly divisible into a ${rows}x${cols} grid`,
    );
  }
  const cellW = sheet.width / cols;
  const cellH = sheet.height / rows;
  const emptyCells = options.emptyCells ?? [];
  const emptyKeys = new Set(emptyCells.map(([r, c]) => `${r},${c}`));
  const autoNudge = options.autoNudge;
  const rowOffsets: number[] =
    autoNudge?.enabled === true
      ? inferRowOffsets(
          sheet,
          rows,
          cellH,
          autoNudge.maxVerticalShiftPx ?? 12,
          autoNudge.backgroundDistanceThreshold ?? 24,
        )
      : new Array(rows).fill(0);
  const colOffsets: number[] =
    autoNudge?.enabled === true
      ? inferColOffsets(
          sheet,
          cols,
          cellW,
          Math.max(2, Math.floor((autoNudge.maxVerticalShiftPx ?? 12) / 2)),
          autoNudge.backgroundDistanceThreshold ?? 24,
        )
      : new Array(cols).fill(0);

  const cells: SliceBbox[] = [];
  let index = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const empty = emptyKeys.has(`${r},${c}`);
      const x0 = clamp(c * cellW + (colOffsets[c] ?? 0), 0, sheet.width - cellW);
      const y0 = clamp(r * cellH + (rowOffsets[r] ?? 0), 0, sheet.height - cellH);
      cells.push({ index: empty ? -1 : index, row: r, col: c, x0, y0, w: cellW, h: cellH, empty });
      if (!empty) index++;
    }
  }
  return {
    sheetW: sheet.width,
    sheetH: sheet.height,
    rows,
    cols,
    cellW,
    cellH,
    rowOffsets,
    colOffsets,
    cells,
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

// ─────────────────────────────────────────────────────────────────────────────
// Slicer v2 — Content-aware band slicer
//
// Scans every column (top→bottom) and every row (left→right) for lines that
// are entirely background colour. Consecutive such lines form a "band". The
// cut is placed at the centre of each band. No fixed grid assumed — the sheet
// is allowed to have sprites of different sizes.
// ─────────────────────────────────────────────────────────────────────────────

export interface SliceOptionsV2 {
  /** RGB Euclidean-distance threshold for "is this pixel background?". Default: 24 */
  readonly bgThreshold?: number;
  /** Minimum width/height (px) of a background band to be treated as a cut. Default: 2 */
  readonly minBandPx?: number;
  /** Cells to mark as empty by (row, col). */
  readonly emptyCells?: ReadonlyArray<readonly [number, number]>;
}

interface Band {
  readonly start: number;
  readonly end: number;
}

interface ContentBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

function findBgColumns(
  sheet: PNG,
  bg: readonly [number, number, number],
  threshold: number,
): boolean[] {
  const result = new Array<boolean>(sheet.width).fill(true);
  for (let x = 0; x < sheet.width; x++) {
    for (let y = 0; y < sheet.height; y++) {
      const idx = (y * sheet.width + x) * 4;
      const r = sheet.data[idx] ?? 0;
      const g = sheet.data[idx + 1] ?? 0;
      const b = sheet.data[idx + 2] ?? 0;
      if (rgbDistanceSq(r, g, b, bg[0], bg[1], bg[2]) > threshold * threshold) {
        result[x] = false;
        break;
      }
    }
  }
  return result;
}

function findBgRows(
  sheet: PNG,
  bg: readonly [number, number, number],
  threshold: number,
): boolean[] {
  const result = new Array<boolean>(sheet.height).fill(true);
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const idx = (y * sheet.width + x) * 4;
      const r = sheet.data[idx] ?? 0;
      const g = sheet.data[idx + 1] ?? 0;
      const b = sheet.data[idx + 2] ?? 0;
      if (rgbDistanceSq(r, g, b, bg[0], bg[1], bg[2]) > threshold * threshold) {
        result[y] = false;
        break;
      }
    }
  }
  return result;
}

function maskToBands(mask: boolean[], minWidth: number): Band[] {
  const bands: Band[] = [];
  let inBand = false;
  let bandStart = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && !inBand) {
      inBand = true;
      bandStart = i;
    } else if (!mask[i] && inBand) {
      inBand = false;
      if (i - bandStart >= minWidth) {
        bands.push({ start: bandStart, end: i - 1 });
      }
    }
  }
  if (inBand && mask.length - bandStart >= minWidth) {
    bands.push({ start: bandStart, end: mask.length - 1 });
  }
  return bands;
}

function inferContentBounds(
  sheet: PNG,
  bg: readonly [number, number, number],
  threshold: number,
): ContentBounds | null {
  const colForeground = new Array<number>(sheet.width).fill(0);
  const rowForeground = new Array<number>(sheet.height).fill(0);
  const limitSq = threshold * threshold;
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const idx = (y * sheet.width + x) * 4;
      const r = sheet.data[idx] ?? 0;
      const g = sheet.data[idx + 1] ?? 0;
      const b = sheet.data[idx + 2] ?? 0;
      if (rgbDistanceSq(r, g, b, bg[0], bg[1], bg[2]) > limitSq) {
        colForeground[x] = (colForeground[x] ?? 0) + 1;
        rowForeground[y] = (rowForeground[y] ?? 0) + 1;
      }
    }
  }

  const hasAnyForeground = colForeground.some((count) => count > 0);
  if (!hasAnyForeground) return null;
  // Ignore isolated edge noise by requiring a tiny amount of foreground
  // coverage along each axis before we treat a line as "content-bearing".
  const minFgPerCol = Math.max(2, Math.floor(sheet.height * 0.01));
  const minFgPerRow = Math.max(2, Math.floor(sheet.width * 0.01));
  const colThreshold = colForeground.some((count) => count >= minFgPerCol) ? minFgPerCol : 1;
  const rowThreshold = rowForeground.some((count) => count >= minFgPerRow) ? minFgPerRow : 1;
  const minX = colForeground.findIndex((count) => count >= colThreshold);
  const maxX =
    colForeground.length -
    1 -
    [...colForeground].reverse().findIndex((count) => count >= colThreshold);
  const minY = rowForeground.findIndex((count) => count >= rowThreshold);
  const maxY =
    rowForeground.length -
    1 -
    [...rowForeground].reverse().findIndex((count) => count >= rowThreshold);
  if (minX < 0 || minY < 0 || maxX < 0 || maxY < 0) return null;
  return { minX, maxX, minY, maxY };
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * V2: content-aware slicer that finds background bands and cuts at their
 * centres. Does not require a pre-specified grid — the cut positions are
 * inferred entirely from pixel data.
 */
export function computeSliceMapV2(sheetPng: Buffer, options: SliceOptionsV2 = {}): SliceMap {
  const bgThreshold = options.bgThreshold ?? 24;
  const minBandPx = options.minBandPx ?? 2;
  const outerBorderPx = 1;
  const sheet = PNG.sync.read(sheetPng);
  const bg = estimateSheetBackgroundRgb(sheet);

  const content = inferContentBounds(sheet, bg, bgThreshold);
  const xStart = content ? Math.max(0, content.minX - outerBorderPx) : 0;
  const xEnd = content ? Math.min(sheet.width, content.maxX + outerBorderPx + 1) : sheet.width;
  const yStart = content ? Math.max(0, content.minY - outerBorderPx) : 0;
  const yEnd = content ? Math.min(sheet.height, content.maxY + outerBorderPx + 1) : sheet.height;

  const colBands = maskToBands(findBgColumns(sheet, bg, bgThreshold), minBandPx);
  const rowBands = maskToBands(findBgRows(sheet, bg, bgThreshold), minBandPx);

  // Cut positions = trimmed content bounds + centre of each interior background band.
  // Bands that touch the trimmed edges are outer margins and should not become cuts.
  const innerColBands = colBands.filter((b) => b.start > xStart && b.end < xEnd - 1);
  const innerRowBands = rowBands.filter((b) => b.start > yStart && b.end < yEnd - 1);

  const xCuts = uniqueSorted([
    xStart,
    ...innerColBands
      .map((b) => Math.round((b.start + b.end) / 2))
      .filter((x) => x > xStart && x < xEnd),
    xEnd,
  ]);
  const yCuts = uniqueSorted([
    yStart,
    ...innerRowBands
      .map((b) => Math.round((b.start + b.end) / 2))
      .filter((y) => y > yStart && y < yEnd),
    yEnd,
  ]);

  const cols = xCuts.length - 1;
  const rows = yCuts.length - 1;

  const emptyCells = options.emptyCells ?? [];
  const emptyKeys = new Set(emptyCells.map(([r, c]) => `${r},${c}`));

  const cells: SliceBbox[] = [];
  let index = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = xCuts[c]!;
      const y0 = yCuts[r]!;
      const w = xCuts[c + 1]! - x0;
      const h = yCuts[r + 1]! - y0;
      const empty = emptyKeys.has(`${r},${c}`);
      cells.push({ index: empty ? -1 : index, row: r, col: c, x0, y0, w, h, empty });
      if (!empty) index++;
    }
  }

  const cellW = cols > 0 ? Math.round((xEnd - xStart) / cols) : sheet.width;
  const cellH = rows > 0 ? Math.round((yEnd - yStart) / rows) : sheet.height;

  return {
    sheetW: sheet.width,
    sheetH: sheet.height,
    rows,
    cols,
    cellW,
    cellH,
    rowOffsets: new Array<number>(rows).fill(0),
    colOffsets: new Array<number>(cols).fill(0),
    cells,
  };
}

/**
 * Canonical sheet slicer.
 *
 * Uses the same content-aware map as the debugger (computeSliceMapV2), then
 * extracts one PNG per non-empty cell in reading order.
 */
export function sliceSheetV2(sheetPng: Buffer, options: SliceOptionsV2 = {}): Buffer[] {
  const sheet = PNG.sync.read(sheetPng);
  const sliceMap = computeSliceMapV2(sheetPng, options);
  const out: Buffer[] = [];
  for (const cell of sliceMap.cells) {
    if (cell.empty) continue;
    out.push(extractCell(sheet, cell.x0, cell.y0, cell.w, cell.h));
  }
  return out;
}

/**
 * Convenience wrapper that pulls grid shape and empty cells from a brief.
 */
export function sliceSheetFromBrief(sheetPng: Buffer, brief: Brief): Buffer[] {
  return sliceSheetV2(sheetPng, {
    emptyCells: brief.generation.sheet.emptyCells,
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
