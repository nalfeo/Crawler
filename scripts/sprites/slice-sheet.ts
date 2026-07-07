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
 * (the brief's commanded rows×cols). The brief contractually commands a regular
 * grid, so it is the authoritative cell COUNT. When band detection over-segments
 * an axis — as happens for gappy subjects whose interior negative space reads as
 * a spurious gutter — the slicer keeps cutting at the REAL detected gutters but
 * drops the spurious one(s), choosing the subset that splits the axis most evenly;
 * when it under-segments, it falls back to a uniform split. Either way it emits
 * exactly the commanded count and every sheet reaches human gallery review (the
 * intended quality gate). The debugger passes no `expectedGrid` and is unchanged.
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
   * The grid the sheet was *commanded* to use (from the brief). When supplied,
   * the slicer reconciles each axis to this cell count: an over-segmented axis
   * drops spurious gutters (cutting only at real detected gutters, most-even
   * subset), an under-segmented axis falls back to a uniform split. Omit it (as
   * the debugger does) to keep pure content-aware behaviour. See `computeSliceMap`.
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
 * integer cut positions. Used by the under-segmentation fallback in
 * `computeSliceMap` when there are too few real gutters to cut on. For real
 * sheets (span ≫ n) the positions are strictly increasing, so this always yields
 * exactly `n` cells.
 */
function uniformCuts(start: number, end: number, n: number): number[] {
  const cuts = new Array<number>(n + 1);
  for (let i = 0; i <= n; i++) {
    cuts[i] = Math.round(start + ((end - start) * i) / n);
  }
  return cuts;
}

/**
 * From `candidates` (interior cut positions, strictly sorted and inside
 * `(start, end)`), choose the `targetCells - 1` cuts that partition `[start, end]`
 * into `targetCells` cells with the most-even widths, and return the full
 * `targetCells + 1` cut array with the fixed outer edges `start`/`end` included.
 *
 * "Most even" = minimum variance of cell widths. Because the widths always sum to
 * `end - start`, minimising their variance is equivalent to minimising the sum of
 * their squares, which a small dynamic program (O(k² · targetCells), k =
 * candidate count) solves exactly. Crucially we only ever cut at REAL detected
 * gutters, so no alignment test is needed: a sheet whose gutters sit slightly
 * off-centre still slices cleanly, and a spurious interior gutter (a gappy
 * subject's internal negative space) is dropped for free because keeping it would
 * make the widths less even.
 *
 * Requires `candidates.length >= targetCells - 1`; callers handle the
 * under-segmented case (too few gutters) before calling.
 *
 * Deterministic: all inputs are integer pixel positions and every cost is an
 * integer sum of squares, so there is no float tie-break ambiguity. When two
 * subsets share the minimum cost, the strict `<` comparisons keep the first one
 * reached in ascending candidate order (the leftmost subset), so the same sheet
 * always slices identically across runs.
 */
function selectEvenCuts(
  candidates: readonly number[],
  start: number,
  end: number,
  targetCells: number,
): number[] {
  const interiorNeeded = targetCells - 1;
  if (interiorNeeded <= 0) return [start, end];
  const k = candidates.length;
  const INF = Number.POSITIVE_INFINITY;
  // dp[t][c] = min sum of squared widths for the first t cells when the t-th
  // interior cut is candidates[c]. prev[t][c] reconstructs the chosen cuts.
  const dp: number[][] = Array.from({ length: interiorNeeded + 1 }, () =>
    new Array<number>(k).fill(INF),
  );
  const prev: number[][] = Array.from({ length: interiorNeeded + 1 }, () =>
    new Array<number>(k).fill(-1),
  );
  for (let c = 0; c < k; c++) {
    const w = candidates[c]! - start;
    dp[1]![c] = w * w;
  }
  for (let t = 2; t <= interiorNeeded; t++) {
    for (let c = t - 1; c < k; c++) {
      for (let c2 = t - 2; c2 < c; c2++) {
        const base = dp[t - 1]![c2]!;
        if (base === INF) continue;
        const w = candidates[c]! - candidates[c2]!;
        const cost = base + w * w;
        if (cost < dp[t]![c]!) {
          dp[t]![c] = cost;
          prev[t]![c] = c2;
        }
      }
    }
  }
  // Close the final cell (last interior cut → end) and pick the best endpoint.
  let bestC = -1;
  let bestCost = INF;
  for (let c = interiorNeeded - 1; c < k; c++) {
    const base = dp[interiorNeeded]![c]!;
    if (base === INF) continue;
    const w = end - candidates[c]!;
    const cost = base + w * w;
    if (cost < bestCost) {
      bestCost = cost;
      bestC = c;
    }
  }
  const chosen: number[] = [];
  for (let t = interiorNeeded, c = bestC; t >= 1 && c >= 0; t--) {
    chosen.push(candidates[c]!);
    c = prev[t]![c]!;
  }
  chosen.reverse();
  return [start, ...chosen, end];
}

/**
 * Reconcile one axis's content-aware cut array (`[start, ...interior, end]`) to
 * the brief's commanded cell count. An over-segmented axis drops spurious gutters
 * via `selectEvenCuts` (cutting only at real detected gutters); an under-segmented
 * axis falls back to a uniform split. Returns the reconciled `targetCells + 1`
 * cut positions.
 */
function reconcileAxisCuts(
  axisCuts: readonly number[],
  start: number,
  end: number,
  targetCells: number,
): number[] {
  const interior = axisCuts.slice(1, -1);
  const interiorNeeded = targetCells - 1;
  if (interior.length === interiorNeeded) return [...axisCuts];
  if (interior.length > interiorNeeded) {
    return selectEvenCuts(interior, start, end, targetCells);
  }
  return uniformCuts(start, end, targetCells);
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

  // Generation reconciliation: reconcile the detected grid to the brief's
  // commanded rows×cols.
  //
  // `build-prompt` commands a *regular* rows×cols grid of same-size cells (see
  // sheetLayoutBlock), so the brief's declared grid is the authoritative cell
  // COUNT. Content-aware detection can still disagree with that count: a gappy
  // subject (e.g. a rubble pile) leaves interior negative space that reads as a
  // spurious full-length background band, so a commanded 4×4 sheet is detected as
  // 5×4 and the `cells === variantCount(brief)` gate would reject a sheet that
  // actually holds the right number of subjects.
  //
  // Per axis, independently (see `reconcileAxisCuts`):
  //   • detected interior cuts == commanded − 1  → already correct, keep as-is.
  //   • detected interior cuts >  commanded − 1  → over-segmented. Keep cutting at
  //     REAL detected gutters but drop the spurious one(s): pick the subset that
  //     splits the axis most evenly (`selectEvenCuts`). No theoretical/uniform
  //     positions are used, so slightly off-centre gutters never clip art, and a
  //     phantom interior gutter falls out because keeping it is less even.
  //   • detected interior cuts <  commanded − 1  → under-segmented (subjects drew
  //     merged, no real gutter between them). There are no true boundaries to cut
  //     on, so fall back to a uniform even split to still emit the commanded count.
  //
  // Either reconcile path always yields exactly the commanded count, so the
  // generation count gate passes and every sheet reaches human gallery review —
  // the intended quality gate (product decision 2026-07-07): occasional
  // half-sprite edge artifacts from a genuinely-off layout are cheap for a human
  // to reject, and are preferable to auto-rejecting honest-but-gappy sheets. The
  // debugger path passes no `expectedGrid` and is byte-for-byte unchanged.
  const expectedGrid = options.expectedGrid;
  if (expectedGrid) {
    gridXCuts = reconcileAxisCuts(xCuts, xStart, xEnd, expectedGrid.cols);
    gridYCuts = reconcileAxisCuts(yCuts, yStart, yEnd, expectedGrid.rows);
    cols = gridXCuts.length - 1;
    rows = gridYCuts.length - 1;
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
 * and is used unchanged, but when a gappy subject over-segments an axis the
 * slicer drops the spurious gutter(s) — cutting at the most-even subset of REAL
 * detected gutters — so it emits the commanded cell count and the sheet reaches
 * human gallery review. See `computeSliceMap`.
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
