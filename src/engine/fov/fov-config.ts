/**
 * FOV configuration helpers (engine layer).
 *
 * Bridges the core's unit-agnostic integer `subFactor` (how many sub-tiles a
 * tile splits into per axis) and the pixel-oriented `cellPx` the lab UI speaks
 * in, mirroring the lighting-config preset pattern so FOV granularity becomes a
 * runtime-tunable, lab-testable knob.
 *
 * Pure + tileSize-parameterized (no rendering imports) so it is unit-testable.
 * The sub-factor clamp/normalize logic is imported from core to keep a single
 * source of truth (engine may depend on core).
 */

import {
  DEFAULT_FOV_SUB_FACTOR,
  MAX_FOV_SUB_FACTOR,
  normalizeSubFactor,
} from '../../core/map/FloorMap';

/**
 * Canonical tile size in pixels (PIXELS_PER_FOOT × tileSizeFt = 8 × 4). Used to
 * convert between the pixel-facing `cellPx` and the core integer `subFactor`.
 */
export const FOV_TILE_SIZE_PX = 32;

/**
 * cellPx presets → each maps to an exact integer sub-factor at 32px tiles:
 * `tile` 32→1, `halfTile` 16→2 (default), `quarterTile` 8→4, `fine` 4→8.
 */
export const FOV_PRESET_CELL_PX = {
  tile: 32,
  halfTile: 16,
  quarterTile: 8,
  fine: 4,
} as const;

export type FovPresetId = keyof typeof FOV_PRESET_CELL_PX;

/**
 * Default preset — 16px cells (sub-factor 2), preserving the historical
 * quarter-tile FOV resolution. Finer presets are opt-in at runtime only.
 */
export const DEFAULT_FOV_PRESET: FovPresetId = 'halfTile';

export interface FovConfig {
  /** Sub-tile cell size in pixels (derived from `subFactor`; UI-facing). */
  cellPx: number;
  /** Canonical integer sub-tile factor (core source of truth). */
  subFactor: number;
  /**
   * Discovered-but-not-visible dim light level. This value is OWNED by the
   * lighting config (`LightingConfig.discoveredLight`); it is surfaced here as a
   * read/write-through so the FOV lab folder can tune the discovered-darkening
   * feature that FOV produces. Clamped to `[0, 1]` (and to `ambient`) downstream.
   */
  discoveredLight: number;
}

export interface FovPerfSnapshot {
  /** EWMA of the per-frame FOV compute cost, milliseconds. */
  computeMsAvg: number;
  /** Most recent single-frame FOV compute cost, milliseconds. */
  lastComputeMs: number;
  /** Active sub-tile factor. */
  subFactor: number;
  /** Derived cell size in pixels. */
  cellPx: number;
}

/** Convert an integer sub-factor to its exact cell size in pixels. */
export function subFactorToCellPx(
  subFactor: number,
  tileSizePx: number = FOV_TILE_SIZE_PX,
): number {
  return tileSizePx / normalizeSubFactor(subFactor);
}

/**
 * Convert a desired cell size in pixels to the nearest valid integer sub-factor,
 * rounding to the closest factor and clamping to `[1, MAX_FOV_SUB_FACTOR]`.
 * Falls back to {@link DEFAULT_FOV_SUB_FACTOR} for non-positive/non-finite input.
 */
export function cellPxToSubFactor(cellPx: number, tileSizePx: number = FOV_TILE_SIZE_PX): number {
  if (!Number.isFinite(cellPx) || cellPx <= 0) return DEFAULT_FOV_SUB_FACTOR;
  return normalizeSubFactor(Math.round(tileSizePx / cellPx));
}

/** Look up a preset's cell size in pixels. */
export function getFovPresetCellPx(preset: FovPresetId): number {
  return FOV_PRESET_CELL_PX[preset];
}

/** Convert a preset directly to its (clamped) integer sub-factor. */
export function getFovPresetSubFactor(
  preset: FovPresetId,
  tileSizePx: number = FOV_TILE_SIZE_PX,
): number {
  return cellPxToSubFactor(FOV_PRESET_CELL_PX[preset], tileSizePx);
}

export { DEFAULT_FOV_SUB_FACTOR, MAX_FOV_SUB_FACTOR, normalizeSubFactor };
