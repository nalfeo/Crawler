import { PNG } from 'pngjs';
import type { Brief } from './brief-schema.js';

/**
 * Content-aware sheet slicer.
 *
 * The image provider returns one big PNG containing N sprite variants laid out
 * in a roughly regular grid (reading order: left-to-right, top-to-bottom).
 * `sliceSheet` splits that sheet into individual PNG buffers at each cell's
 * *native* resolution — before any postprocessing. The downstream postprocessor
 * is responsible for quantising, cropping, background removal, and
 * nearest-neighbor resample to each brief's target output size (default 64×64).
 *
 * Cut positions are inferred entirely from pixel data: the slicer scans for
 * rows/columns that are entirely background colour, groups consecutive such
 * lines into "bands", and cuts at each interior band's centre. No fixed grid is
 * assumed, so sprites of slightly different sizes still slice cleanly. This is
 * the exact same map the post-process debugger draws (`/api/slice-map`), so the
 * variants the debugger previews are byte-for-byte what generation produces and
 * what `approve` ships to the catalog.
 *
 * One exception, for the generation path only: callers may pass `expectedGrid`
 * (the brief's commanded rows×cols). When band detection over-segments a single
 * axis by a small margin — the other axis still matches, as happens for gappy
 * subjects whose interior negative space reads as one spurious gutter — the
 * slicer reconciles to the commanded grid via a uniform even split. Genuinely
 * different layouts and gross mismatches are left alone so the count gate still
 * rejects them. The debugger passes no `expectedGrid` and is unchanged.
 *
 * Why slice before postprocessing rather than passing the whole sheet through
 * the existing postprocessor: the sheet's background-removal floodfill would
 * leak across cells if a cell happens to share a corner colour with another
 * cell. Slicing first guarantees each cell is processed in isolation.
 */

export interface SliceBbox {
  /** 0-based variant index in reading order, excluding empty cells. -1 for empty cells. */
  readonly index: number;
  readonly row: number;
  readonly col: number;
  /** Actual top-left x. */
  readonly x0: number;
  /** Actual top-left y. */
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
  /** Nominal cell width (= content width / cols). */
  readonly cellW: number;
  /** Nominal cell height (= content height / rows). */
  readonly cellH: number;
  /** Per-row vertical offset (always 0; retained for SliceMap compatibility). */
  readonly rowOffsets: readonly number[];
  /** Per-column horizontal offset (always 0; retained for SliceMap compatibility). */
  readonly colOffsets: readonly number[];
  /** Every cell in reading order, including empty cells. */
  readonly cells: readonly SliceBbox[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Content-aware band slicer
//
// Scans every column (top→bottom) and every row (left→right) for lines that
// are entirely background colour. Consecutive such lines form a "band". The
// cut is placed at the centre of each interior band. No fixed grid assumed —
// the sheet is allowed to have sprites of different sizes.
// ─────────────────────────────────────────────────────────────────────────────

export interface SliceOptions {
  /** RGB Euclidean-distance threshold for "is this pixel background?". Default: 24 */
  readonly bgThreshold?: number;
  /** Minimum width/height (px) of a background band to be treated as a cut. Default: 2 */
  readonly minBandPx?: number;
  /** Cells to mark as empty by (row, col). */
  readonly emptyCells?: ReadonlyArray<readonly [number, number]>;
  /**
   * The grid the sheet was *commanded* to use (from the brief). When supplied
   * AND content-aware band detection disagrees with it, the slicer falls back
   * to a uniform even split into exactly this grid. Omit it (as the debugger
   * does) to keep pure content-aware behaviour. See `computeSliceMap`.
   */
  readonly expectedGrid?: { readonly rows: number; readonly cols: number };
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
 * Evenly divide `[start, end]` into exactly `n` cells, returning the `n + 1`
 * integer cut positions. Used by the generation reconciliation fallback in
 * `computeSliceMap`. For real sheets (span ≫ n) the positions are strictly
 * increasing, so this always yields exactly `n` cells.
 */
function uniformCuts(start: number, end: number, n: number): number[] {
  const cuts = new Array<number>(n + 1);
  for (let i = 0; i <= n; i++) {
    cuts[i] = Math.round(start + ((end - start) * i) / n);
  }
  return cuts;
}

/**
 * Content-aware slicer that finds background bands and cuts at their centres.
 * Does not require a pre-specified grid — cut positions are inferred entirely
 * from pixel data. This is the canonical map used by both generation
 * (`sliceSheetFromBrief`) and the post-process debugger (`/api/slice-map`).
 */
export function computeSliceMap(sheetPng: Buffer, options: SliceOptions = {}): SliceMap {
  const sheet = PNG.sync.read(sheetPng);

  const bgThreshold = options.bgThreshold ?? 24;
  const minBandPx = options.minBandPx ?? 2;
  const outerBorderPx = 1;
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

  // Cut arrays and grid shape default to the pure content-aware result.
  let gridXCuts = xCuts;
  let gridYCuts = yCuts;
  let cols = xCuts.length - 1;
  let rows = yCuts.length - 1;

  // Generation reconciliation (surgical, over-segmentation only).
  //
  // `build-prompt` commands a *regular* rows×cols grid with same-size cells
  // (see sheetLayoutBlock), so a brief's declared grid is the authoritative
  // contract. Gappy subjects (e.g. a rubble pile) leave interior negative space
  // that reads as a spurious full-length background band, so a commanded 4×4
  // sheet is detected as 5×4 and the `cells === variantCount(brief)` gate
  // rejects a sheet that actually holds the right number of subjects.
  //
  // We reconcile ONLY when the artifact is a small over-segmentation on a single
  // axis: the OTHER axis matches the commanded grid exactly, and the
  // over-segmented axis exceeds it by no more than `MAX_SPURIOUS_BANDS`. Then we
  // uniform-split to the commanded grid, yielding exactly `rows*cols` cells so
  // the gate passes *honestly*. We deliberately do NOT reconcile when both axes
  // differ (a genuinely different layout, e.g. 1×3 vs 2×2), when an axis is
  // UNDER-segmented (merged cells — a real miss), or when over-segmentation is
  // gross (> tolerance): those are real failures the count gate must still
  // reject so generation retries. The debugger path passes no `expectedGrid`.
  const expectedGrid = options.expectedGrid;
  if (expectedGrid) {
    const MAX_SPURIOUS_BANDS = 2;
    const colsOverOnly =
      rows === expectedGrid.rows &&
      cols > expectedGrid.cols &&
      cols <= expectedGrid.cols + MAX_SPURIOUS_BANDS;
    const rowsOverOnly =
      cols === expectedGrid.cols &&
      rows > expectedGrid.rows &&
      rows <= expectedGrid.rows + MAX_SPURIOUS_BANDS;
    if (colsOverOnly || rowsOverOnly) {
      gridXCuts = uniformCuts(xStart, xEnd, expectedGrid.cols);
      gridYCuts = uniformCuts(yStart, yEnd, expectedGrid.rows);
      cols = expectedGrid.cols;
      rows = expectedGrid.rows;
    }
  }

  const emptyCells = options.emptyCells ?? [];
  const emptyKeys = new Set(emptyCells.map(([r, c]) => `${r},${c}`));

  const cells: SliceBbox[] = [];
  let index = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = gridXCuts[c]!;
      const y0 = gridYCuts[r]!;
      const w = gridXCuts[c + 1]! - x0;
      const h = gridYCuts[r + 1]! - y0;
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
 * Uses the content-aware map (`computeSliceMap`) — the same map drawn by the
 * post-process debugger — then extracts one PNG per non-empty cell in reading
 * order.
 */
export function sliceSheet(sheetPng: Buffer, options: SliceOptions = {}): Buffer[] {
  const sheet = PNG.sync.read(sheetPng);
  const sliceMap = computeSliceMap(sheetPng, options);
  const out: Buffer[] = [];
  for (const cell of sliceMap.cells) {
    if (cell.empty) continue;
    out.push(extractCell(sheet, cell.x0, cell.y0, cell.w, cell.h));
  }
  return out;
}

/**
 * Convenience wrapper that pulls the grid contract from a brief. `emptyCells`
 * are forwarded as before, and the brief's declared `rows`/`cols` are passed as
 * `expectedGrid`: for a well-formed sheet the content-aware map already matches
 * and is used unchanged, but when a gappy subject over-segments a single axis by
 * a small margin the slicer reconciles to the brief's commanded grid (uniform
 * even split) instead of emitting the wrong cell count. Genuinely different
 * layouts are left content-aware so the count gate still rejects them. See
 * `computeSliceMap`.
 */
export function sliceSheetFromBrief(sheetPng: Buffer, brief: Brief): Buffer[] {
  const { rows, cols, emptyCells } = brief.generation.sheet;
  return sliceSheet(sheetPng, { emptyCells, expectedGrid: { rows, cols } });
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
