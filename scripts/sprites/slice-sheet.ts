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
 * (the brief's commanded rows×cols). It is used ONLY as a soft tiebreak anchor —
 * NEVER a hard constraint. The slicer never invents a cut: it cuts only at REAL
 * detected gutters, trims runt edge cells (a partial sprite the model tacked on
 * past the last full gutter — the "chopped right side" symptom), then picks the
 * cut subset that yields the most same-sized sprites (interior spurious gutters
 * fall out because dropping them is more even). The emitted grid is therefore
 * DATA-DRIVEN from the sheet, at its HONEST count, which is carried to human
 * gallery review — the intended quality gate — rather than force-fitting the
 * commanded count by cutting through art. The debugger passes no `expectedGrid`
 * and is byte-for-byte unchanged. See ADR 0052.
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

/**
 * Result of slicing a sheet against a brief (generation / rerun paths). Carries
 * the extracted cell buffers PLUS the DATA-DRIVEN grid the slicer actually landed
 * on (which may differ from the brief's commanded grid — a runt edge trimmed or a
 * spurious gutter merged) so callers persist the ACTUAL grid/count, not the
 * commanded one. `variantCount` is a sibling of `grid` (not nested) so a
 * persisted `RunSummary.grid` keeps its `{ rows, cols, emptyCells }` shape.
 */
export interface BriefSliceResult {
  /** One PNG buffer per non-empty cell, in reading order. */
  readonly cells: Buffer[];
  /** The grid the slicer actually landed on — from the sheet, not the brief. */
  readonly grid: {
    readonly rows: number;
    readonly cols: number;
    readonly emptyCells: ReadonlyArray<readonly [number, number]>;
  };
  /** Number of non-empty cells (`= cells.length`) — the ACTUAL variant count. */
  readonly variantCount: number;
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
   * it is a SOFT anchor only: the slicer still cuts exclusively at real detected
   * gutters, trims runt edge cells, and picks the most-uniform cut subset, using
   * this count solely to break ties between equally-uniform candidates. Omit it
   * (as the debugger does) to keep pure content-aware behaviour. See
   * `computeSliceMap` and `chooseAxisCuts`.
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

interface BackgroundSample {
  readonly rgb: readonly [number, number, number];
  readonly isTransparent: boolean;
}

function findBgColumns(sheet: PNG, bg: BackgroundSample, threshold: number): boolean[] {
  const result = new Array<boolean>(sheet.width).fill(true);
  const thresholdSq = threshold * threshold;
  for (let x = 0; x < sheet.width; x++) {
    for (let y = 0; y < sheet.height; y++) {
      const idx = (y * sheet.width + x) * 4;
      // Fully transparent pixel is always background regardless of RGB values.
      // This is critical for icon sheets where gutters are transparent (alpha=0)
      // and the RGB channels at those positions may differ from the estimated
      // background colour (causing them to be mis-classified as foreground).
      if ((sheet.data[idx + 3] ?? 255) === 0) continue;
      if (bg.isTransparent) {
        result[x] = false;
        break;
      }
      const r = sheet.data[idx] ?? 0;
      const g = sheet.data[idx + 1] ?? 0;
      const b = sheet.data[idx + 2] ?? 0;
      if (rgbDistanceSq(r, g, b, bg.rgb[0], bg.rgb[1], bg.rgb[2]) > thresholdSq) {
        result[x] = false;
        break;
      }
    }
  }
  return result;
}

function findBgRows(sheet: PNG, bg: BackgroundSample, threshold: number): boolean[] {
  const result = new Array<boolean>(sheet.height).fill(true);
  const thresholdSq = threshold * threshold;
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const idx = (y * sheet.width + x) * 4;
      // Fully transparent pixel is always background regardless of RGB values.
      if ((sheet.data[idx + 3] ?? 255) === 0) continue;
      if (bg.isTransparent) {
        result[y] = false;
        break;
      }
      const r = sheet.data[idx] ?? 0;
      const g = sheet.data[idx + 1] ?? 0;
      const b = sheet.data[idx + 2] ?? 0;
      if (rgbDistanceSq(r, g, b, bg.rgb[0], bg.rgb[1], bg.rgb[2]) > thresholdSq) {
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
  bg: BackgroundSample,
  threshold: number,
): ContentBounds | null {
  const colForeground = new Array<number>(sheet.width).fill(0);
  const rowForeground = new Array<number>(sheet.height).fill(0);
  const limitSq = threshold * threshold;
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const idx = (y * sheet.width + x) * 4;
      // Fully transparent pixel is always background regardless of RGB values.
      if ((sheet.data[idx + 3] ?? 255) === 0) continue;
      if (bg.isTransparent) {
        colForeground[x] = (colForeground[x] ?? 0) + 1;
        rowForeground[y] = (rowForeground[y] ?? 0) + 1;
        continue;
      }
      const r = sheet.data[idx] ?? 0;
      const g = sheet.data[idx + 1] ?? 0;
      const b = sheet.data[idx + 2] ?? 0;
      if (rgbDistanceSq(r, g, b, bg.rgb[0], bg.rgb[1], bg.rgb[2]) > limitSq) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Data-driven grid selection (generation path only)
//
// The slicer NEVER invents a cut. With a soft `expectedGrid` anchor it cuts only
// at REAL detected gutters, then (a) trims runt edge cells — an incomplete
// partial sprite the model tacked on past the last full gutter, the "chopped
// right side" symptom — and (b) picks the cut subset yielding the most same-size
// sprites, using the commanded count only as a tiebreak anchor. All math is
// integer / cross-multiplied (no floats, no Math.random, no Date.now) so a given
// sheet always slices identically. See ADR 0052.
// ─────────────────────────────────────────────────────────────────────────────

/** Cell sizes (px) between consecutive cut positions: `cuts[i+1] - cuts[i]`. */
function consecutiveDiffs(cuts: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < cuts.length; i++) out.push(cuts[i]! - cuts[i - 1]!);
  return out;
}

/**
 * Lower median of `sizes` — the element at `floor((n-1)/2)` of the ascending
 * sort. Using the LOWER median (not the mean of the two middles) keeps the
 * reference an integer and biased toward the smaller-but-regular cell, so a
 * single oversized merged blob can't drag the "regular" reference up past the
 * true cell size. `sizes` must be non-empty.
 */
function lowerMedian(sizes: readonly number[]): number {
  const sorted = [...sizes].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

// Edge-runt trim + regularity thresholds, as integer ratios (cross-multiplied at
// the call sites so there is no float division). Named so a human can retune the
// policy without hunting magic numbers.
//
//   RUNT_SMALL:  a runt edge cell is "too small" when size < 3/5 (60%) of the
//     lower median; its inward neighbour must itself be "full" (>= 60% of median)
//     so we never trim when BOTH edge cells are small (a genuinely tiny grid).
//   RUNT_MERGE:  phantom-merge guard — if runt + neighbour together fall within
//     2/5 (40%) of ONE median cell they are the two halves of a single sprite
//     split by a spurious interior gutter; keep the CELL (the count search drops
//     the false CUT instead).
//   RUNT_PAIR:   a two-cell axis has no reliable median, so trim the smaller cell
//     only when it is < 1/2 (50%) of the larger.
//   REGULAR_TOL: a cell counts as "regular" (same-size) for the uniformity score
//     when |size - median| <= 2/5 (40%) of the median.
const RUNT_SMALL_NUM = 3;
const RUNT_SMALL_DEN = 5;
const RUNT_MERGE_NUM = 2;
const RUNT_MERGE_DEN = 5;
const RUNT_PAIR_NUM = 1;
const RUNT_PAIR_DEN = 2;
const REGULAR_TOL_NUM = 2;
const REGULAR_TOL_DEN = 5;

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
 * Decide whether the leading or trailing cell of `sizes` is a runt edge cell to
 * drop (a partial sprite tacked on past the last full gutter), or `null` to keep
 * both edges. See the RUNT_* constants for the exact policy.
 */
function pickRuntEdge(sizes: readonly number[]): 'lead' | 'tail' | null {
  const n = sizes.length;
  if (n <= 1) return null;
  if (n === 2) {
    // No reliable median for two cells: trim the smaller only if it is < 50% of
    // the larger. Tie (equal sizes) → keep both.
    const a = sizes[0]!;
    const b = sizes[1]!;
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    if (min * RUNT_PAIR_DEN >= max * RUNT_PAIR_NUM) return null;
    return a <= b ? 'lead' : 'tail';
  }
  const median = lowerMedian(sizes);
  const leadRunt = isEdgeRunt(sizes[0]!, sizes[1]!, median);
  const tailRunt = isEdgeRunt(sizes[n - 1]!, sizes[n - 2]!, median);
  if (leadRunt && tailRunt) {
    // Drop the smaller runt first; tie → the leading edge (deterministic).
    return sizes[0]! <= sizes[n - 1]! ? 'lead' : 'tail';
  }
  if (leadRunt) return 'lead';
  if (tailRunt) return 'tail';
  return null;
}

/**
 * True when `size` is a tacked-on partial edge cell that should be dropped: too
 * small (< 60% median), its inward `neighbour` is full (>= 60% median), and the
 * two are NOT plausibly one median-sized sprite split by a spurious interior
 * gutter (`phantomHalf`).
 *
 * `phantomHalf` is a deliberately BROAD, conservative KEEP guard — not a precise
 * 0.5/0.5 half-detector. Whenever `size + neighbour` lands within 40% of ONE
 * median cell, the pair is treated as possibly-real art and KEPT for human
 * review rather than trimmed. This intentionally errs toward keeping an ambiguous
 * edge cell: dropping it would risk chopping real art off the edge — the exact
 * failure this salvage path exists to prevent (ADR 0052). Trimming only ever
 * drops a cell bounded by real DETECTED gutters, so it never cuts THROUGH
 * foreground; the only question here is keep-vs-drop of an ambiguous edge, and
 * the bias is deliberately KEEP.
 */
function isEdgeRunt(size: number, neighbour: number, median: number): boolean {
  const tooSmall = size * RUNT_SMALL_DEN < median * RUNT_SMALL_NUM;
  const neighbourFull = neighbour * RUNT_SMALL_DEN >= median * RUNT_SMALL_NUM;
  const phantomHalf =
    Math.abs(size + neighbour - median) * RUNT_MERGE_DEN <= median * RUNT_MERGE_NUM;
  return tooSmall && neighbourFull && !phantomHalf;
}

/**
 * Trim runt edge cells from a cut array by dropping the outermost cut position,
 * iteratively, until neither edge is a runt or only one cell remains. Operates
 * on cut POSITIONS so every surviving cut stays at a real detected gutter.
 */
function trimEdgeRunts(cuts: readonly number[]): number[] {
  let arr = [...cuts];
  for (;;) {
    if (arr.length - 1 <= 1) break; // 1 cell (2 cuts) left → nothing to trim
    const edge = pickRuntEdge(consecutiveDiffs(arr));
    if (edge === null) break;
    arr = edge === 'lead' ? arr.slice(1) : arr.slice(0, -1);
  }
  return arr;
}

interface AxisScore {
  readonly regularCount: number;
  readonly anchorDelta: number;
  readonly dispersion: number;
  readonly cells: number;
}

/**
 * Score a candidate `k`-cell partition: how many cells are "regular" (within
 * ±40% of the lower median), how far the count is from the commanded anchor, and
 * the total squared size deviation. Pure integer math.
 */
function scoreAxisCuts(cuts: readonly number[], expectedCells: number): AxisScore {
  const sizes = consecutiveDiffs(cuts);
  const median = lowerMedian(sizes);
  let regularCount = 0;
  let dispersion = 0;
  for (const s of sizes) {
    if (Math.abs(s - median) * REGULAR_TOL_DEN <= median * REGULAR_TOL_NUM) regularCount++;
    const d = s - median;
    dispersion += d * d;
  }
  return {
    regularCount,
    anchorDelta: Math.abs(sizes.length - expectedCells),
    dispersion,
    cells: sizes.length,
  };
}

/**
 * Strict "is `a` a better partition than `b`" total order:
 *   1. more regular (same-size) cells                         [PRIMARY]
 *   2. closer to the commanded count (soft anchor) — BEFORE dispersion, so a
 *      legitimately uneven 2-cell axis (e.g. a 40/60 split) is not collapsed to
 *      a single big cell just because one cell scores dispersion 0
 *   3. lower size dispersion (tighter cell sizes)
 *   4. more cells (prefer keeping real sprites over merging)
 * A full tie keeps the incumbent; the caller seeds with the max-cell (untrimmed)
 * candidate and the leftmost `selectEvenCuts` subset within each `k`, so slicing
 * is deterministic.
 */
function betterAxisScore(a: AxisScore, b: AxisScore): boolean {
  if (a.regularCount !== b.regularCount) return a.regularCount > b.regularCount;
  if (a.anchorDelta !== b.anchorDelta) return a.anchorDelta < b.anchorDelta;
  if (a.dispersion !== b.dispersion) return a.dispersion < b.dispersion;
  return a.cells > b.cells;
}

/**
 * Choose one axis's cut positions from the REAL detected gutters. Never invents a
 * cut. First trims runt edge cells (`trimEdgeRunts`), then over the trimmed cuts
 * picks the cell count `k ∈ [1, detected]` maximising size-uniformity, using
 * `expectedCells` (the brief's commanded count) only as a soft tiebreak anchor.
 * For `k < detected` the most-even `k`-subset comes from `selectEvenCuts` (which
 * merges spurious interior gutters for free). Returns `k + 1` cut positions.
 */
function chooseAxisCuts(axisCuts: readonly number[], expectedCells: number): number[] {
  const trimmed = trimEdgeRunts(axisCuts);
  const start = trimmed[0]!;
  const end = trimmed[trimmed.length - 1]!;
  const interior = trimmed.slice(1, -1);
  const detected = trimmed.length - 1; // cell count after trim (>= 1)
  // Seed with the full trimmed grid (k = detected, the most cells); a smaller k
  // must be STRICTLY better to win, so ties prefer keeping real sprites.
  let bestCuts = trimmed;
  let bestScore = scoreAxisCuts(trimmed, expectedCells);
  for (let k = 1; k < detected; k++) {
    const cuts = selectEvenCuts(interior, start, end, k);
    const score = scoreAxisCuts(cuts, expectedCells);
    if (betterAxisScore(score, bestScore)) {
      bestScore = score;
      bestCuts = cuts;
    }
  }
  return bestCuts;
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

  // Generation grid selection: when the brief supplies its commanded rows×cols
  // via `expectedGrid`, choose each axis's cuts DATA-DRIVEN from the sheet, using
  // the commanded count only as a soft tiebreak anchor.
  //
  // `build-prompt` commands a *regular* rows×cols grid (see sheetLayoutBlock), but
  // the model does not always draw exactly that: a gappy subject leaves interior
  // negative space that reads as a spurious gutter (over-segmentation), and a
  // wide 3:1 sheet whose subjects don't fill the last column leaves a runt partial
  // sprite on the right edge (the "chopped right side" symptom). The OLD policy
  // force-fit the commanded count — inventing uniform cuts straight through art
  // when detection under-segmented. We now NEVER invent a cut:
  //   • `trimEdgeRunts` drops a runt leading/trailing partial CELL.
  //   • `chooseAxisCuts` keeps only REAL detected gutters and picks the subset
  //     giving the most same-size cells (a spurious interior gutter falls out
  //     because dropping it is more uniform), anchored softly to the commanded
  //     count for ties.
  //
  // The emitted grid is the HONEST data-driven grid at its real count; the
  // generation gate (see generate-one.ts) accepts it and carries it to human
  // gallery review — the intended quality gate (product decision 2026-07-08,
  // ADR 0052, reversing the 2026-07-07 force-count
  // decision). The debugger path passes no `expectedGrid` and is byte-for-byte
  // unchanged.
  const expectedGrid = options.expectedGrid;
  if (expectedGrid) {
    gridXCuts = chooseAxisCuts(xCuts, expectedGrid.cols);
    gridYCuts = chooseAxisCuts(yCuts, expectedGrid.rows);
    cols = gridXCuts.length - 1;
    rows = gridYCuts.length - 1;
  }

  // Honour the brief's `emptyCells` only when the data-driven grid still matches
  // the commanded grid. When the slicer lands on a different grid (a runt edge
  // trimmed or a spurious gutter merged), the brief's empty-cell (row,col)
  // coordinates reference the OLD commanded grid and would blank the wrong cells,
  // so they are dropped. The debugger path (no `expectedGrid`) always honours them.
  const gridMatchesCommanded =
    !expectedGrid || (rows === expectedGrid.rows && cols === expectedGrid.cols);
  const emptyCells = gridMatchesCommanded ? (options.emptyCells ?? []) : [];
  const emptyKeys = new Set(emptyCells.map(([r, c]) => `${r},${c}`));

  const cells: SliceBbox[] = [];
  let index = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Clamp every cell to the sheet so extraction can never read out of
      // bounds. Cut positions come exclusively from real detected gutters within
      // [0, width]/[0, height], so `x0`/`w` are unchanged for every well-formed
      // sheet and the debugger path stays byte-for-byte identical. This clamp is
      // a pure belt-and-braces guard against a degenerate sheet (e.g. zero
      // content span) and never fires on real generation output.
      const rawX0 = gridXCuts[c]!;
      const rawY0 = gridYCuts[r]!;
      const x0 = Math.min(Math.max(0, rawX0), Math.max(0, sheet.width - 1));
      const y0 = Math.min(Math.max(0, rawY0), Math.max(0, sheet.height - 1));
      const w = Math.max(1, Math.min(gridXCuts[c + 1]! - rawX0, sheet.width - x0));
      const h = Math.max(1, Math.min(gridYCuts[r + 1]! - rawY0, sheet.height - y0));
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
  return sliceWithMap(sheetPng, options).cells;
}

/**
 * Slice a sheet and return the extracted cells PLUS the data-driven grid the
 * slicer landed on. Shared by the brief-anchored (`sliceSheetFromBrief`) and
 * persisted-grid-anchored (`sliceSheetWithGrid`) paths so both persist the
 * ACTUAL grid/count.
 */
function sliceWithMap(sheetPng: Buffer, options: SliceOptions): BriefSliceResult {
  const sheet = PNG.sync.read(sheetPng);
  const map = computeSliceMap(sheetPng, options);
  const cells: Buffer[] = [];
  const emptyCells: (readonly [number, number])[] = [];
  for (const cell of map.cells) {
    if (cell.empty) {
      emptyCells.push([cell.row, cell.col]);
      continue;
    }
    cells.push(extractCell(sheet, cell.x0, cell.y0, cell.w, cell.h));
  }
  return {
    cells,
    grid: { rows: map.rows, cols: map.cols, emptyCells },
    variantCount: cells.length,
  };
}

/**
 * Convenience wrapper that pulls the grid contract from a brief. `emptyCells` are
 * forwarded, and the brief's declared `rows`/`cols` are passed as the soft
 * `expectedGrid` anchor. Returns the ACTUAL data-driven grid the slicer landed on
 * (which may differ from the commanded grid — a runt edge trimmed or a spurious
 * gutter merged) so the caller persists the real grid/count. See `computeSliceMap`.
 *
 * Content-aware slicing is used unconditionally for every brief type including
 * `frameSequence`-enabled ones. The brief's layout prompt (see `build-prompt.ts`)
 * requires a visible background gutter between every cell, so the gutter detector
 * keying off that separator is robust and "fails loud" (returns a different
 * `variantCount` than expected) when the model omits the required gutter.
 */
export function sliceSheetFromBrief(sheetPng: Buffer, brief: Brief): BriefSliceResult {
  const { rows, cols, emptyCells } = brief.generation.sheet;
  return sliceWithMap(sheetPng, { emptyCells, expectedGrid: { rows, cols } });
}

/**
 * Re-slice a stored sheet anchored on a PERSISTED actual grid (rerun path). Uses
 * the persisted grid's rows/cols as the soft anchor and its `emptyCells`. For a
 * healthy modern run the deterministic slicer reproduces the persisted grid
 * exactly (identical crops), so re-postprocess re-derives the same row-major
 * per-variant entries; a mismatch signals a corrupt stored grid and is caught by
 * the rerun guard. See `rerun.ts`.
 */
export function sliceSheetWithGrid(
  sheetPng: Buffer,
  grid: {
    readonly rows: number;
    readonly cols: number;
    readonly emptyCells: ReadonlyArray<readonly [number, number]>;
  },
): BriefSliceResult {
  return sliceWithMap(sheetPng, {
    emptyCells: grid.emptyCells,
    expectedGrid: { rows: grid.rows, cols: grid.cols },
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

function estimateSheetBackgroundRgb(sheet: PNG): BackgroundSample {
  const corners: readonly (readonly [number, number])[] = [
    [0, 0],
    [sheet.width - 1, 0],
    [0, sheet.height - 1],
    [sheet.width - 1, sheet.height - 1],
  ] as const;
  let r = 0;
  let g = 0;
  let b = 0;
  let opaqueSamples = 0;
  for (const [x, y] of corners) {
    const idx = (y * sheet.width + x) * 4;
    if ((sheet.data[idx + 3] ?? 255) === 0) continue;
    r += sheet.data[idx] ?? 0;
    g += sheet.data[idx + 1] ?? 0;
    b += sheet.data[idx + 2] ?? 0;
    opaqueSamples++;
  }
  if (opaqueSamples === 0) {
    return { rgb: [0, 0, 0] as const, isTransparent: true };
  }
  return {
    rgb: [
      Math.round(r / opaqueSamples),
      Math.round(g / opaqueSamples),
      Math.round(b / opaqueSamples),
    ] as const,
    isTransparent: false,
  };
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
