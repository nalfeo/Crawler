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
export declare function computeSliceMap(sheetPng: Buffer, options: SliceOptions): SliceMap;
/**
 * Slice a sheet into individual cell PNGs.
 *
 * Returns one buffer per *non-empty* cell, in reading order (row-major,
 * left-to-right top-to-bottom). Empty cells are skipped — the caller gets
 * exactly `rows * cols - emptyCells.length` outputs.
 */
export declare function sliceSheet(sheetPng: Buffer, options: SliceOptions): Buffer[];
export interface SliceOptionsV2 {
  /** RGB Euclidean-distance threshold for "is this pixel background?". Default: 24 */
  readonly bgThreshold?: number;
  /** Minimum width/height (px) of a background band to be treated as a cut. Default: 2 */
  readonly minBandPx?: number;
  /** Cells to mark as empty by (row, col). */
  readonly emptyCells?: ReadonlyArray<readonly [number, number]>;
}
/**
 * V2: content-aware slicer that finds background bands and cuts at their
 * centres. Does not require a pre-specified grid — the cut positions are
 * inferred entirely from pixel data.
 */
export declare function computeSliceMapV2(sheetPng: Buffer, options?: SliceOptionsV2): SliceMap;
/**
 * Convenience wrapper that pulls grid shape and empty cells from a brief.
 */
export declare function sliceSheetFromBrief(sheetPng: Buffer, brief: Brief): Buffer[];
//# sourceMappingURL=slice-sheet.d.ts.map
