const LIGHTING_PRESET_STEPS = {
  tile: 32,
  halfTile: 16,
  quarterTile: 8,
  pixel: 1,
} as const;

export type LightingPresetId = keyof typeof LIGHTING_PRESET_STEPS;

export interface LightingConfig {
  stepPx: number;
  ambient: number;
  /**
   * Light level for discovered-but-not-currently-visible cells (fog "memory").
   * Rendered clamped to `ambient` so remembered terrain is never brighter than
   * the dimmest visible cell. 0 ⇒ explored areas go fully black (legacy).
   */
  discoveredLight: number;
  sourceRadiusPx: number;
  sourceIntensity: number;
  falloffExponent: number;
  softness: boolean;
  updateEveryNFrames: number;
  autoAdjustQuality: boolean;
  targetComputeMs: number;
}

/**
 * Global lighting defaults. These match the values tuned in the AI Runner Lab's
 * Lighting panel and are the base config for any scene without a per-floor
 * override.
 *
 * `ambient` here is only a fallback: the shipped game overrides it PER FLOOR from
 * the floor manifest (see `FloorConfig.lighting.ambient`), so a deeper, darker
 * floor can ship a lower ambient than Floor 1's 0.2. Labs / no-floor contexts
 * fall back to this value.
 */
export const DEFAULT_LIGHTING_CONFIG: LightingConfig = {
  stepPx: 4,
  ambient: 0.2,
  discoveredLight: 0.05,
  sourceRadiusPx: 200,
  sourceIntensity: 0.6,
  falloffExponent: 2.5,
  softness: true,
  updateEveryNFrames: 1,
  autoAdjustQuality: true,
  targetComputeMs: 10,
};

export interface LightField {
  stepPx: number;
  widthCells: number;
  heightCells: number;
  widthPx: number;
  heightPx: number;
  values: Float32Array;
}

export interface LightFieldDirtyRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LightSource {
  x: number;
  y: number;
  radiusPx: number;
  intensity: number;
  /**
   * Packed 0xRRGGBB light colour. Stored for future RGB rendering pipeline
   * support; the current scalar light-field computation uses intensity only.
   */
  colorHex?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampLightingStepPx(stepPx: number, tileSizePx: number): number {
  const step = Number.isFinite(stepPx) ? Math.round(stepPx) : tileSizePx;
  return clamp(step, 1, Math.max(1, Math.round(tileSizePx)));
}

export function createLightField(widthPx: number, heightPx: number, stepPx: number): LightField {
  const safeStepPx = Math.max(1, Math.round(stepPx));
  const widthCells = Math.max(1, Math.ceil(widthPx / safeStepPx));
  const heightCells = Math.max(1, Math.ceil(heightPx / safeStepPx));
  return {
    stepPx: safeStepPx,
    widthCells,
    heightCells,
    widthPx,
    heightPx,
    values: new Float32Array(widthCells * heightCells),
  };
}

export function getLightingPresetStepPx(preset: LightingPresetId, tileSizePx: number): number {
  const raw = LIGHTING_PRESET_STEPS[preset];
  return clampLightingStepPx(raw, tileSizePx);
}

export function buildDirtyRectFromCircles(
  field: LightField,
  circles: ReadonlyArray<{ x: number; y: number; radiusPx: number }>,
): LightFieldDirtyRect | null {
  if (circles.length === 0) return null;
  const step = field.stepPx;
  let minX = field.widthCells;
  let minY = field.heightCells;
  let maxX = -1;
  let maxY = -1;

  for (const circle of circles) {
    const radius = Math.max(0, circle.radiusPx);
    const pxMin = clamp(circle.x - radius, 0, Math.max(0, field.widthPx - 1));
    const pyMin = clamp(circle.y - radius, 0, Math.max(0, field.heightPx - 1));
    const pxMax = clamp(circle.x + radius, 0, Math.max(0, field.widthPx - 1));
    const pyMax = clamp(circle.y + radius, 0, Math.max(0, field.heightPx - 1));
    const cellMinX = Math.floor(pxMin / step);
    const cellMinY = Math.floor(pyMin / step);
    const cellMaxX = Math.floor(pxMax / step);
    const cellMaxY = Math.floor(pyMax / step);
    minX = Math.min(minX, cellMinX);
    minY = Math.min(minY, cellMinY);
    maxX = Math.max(maxX, cellMaxX);
    maxY = Math.max(maxY, cellMaxY);
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    minX: clamp(minX, 0, field.widthCells - 1),
    minY: clamp(minY, 0, field.heightCells - 1),
    maxX: clamp(maxX, 0, field.widthCells - 1),
    maxY: clamp(maxY, 0, field.heightCells - 1),
  };
}

export function buildDirtyRectFromPixelBounds(
  field: LightField,
  minPxX: number,
  minPxY: number,
  maxPxX: number,
  maxPxY: number,
): LightFieldDirtyRect {
  const maxFieldPxX = Math.max(0, field.widthPx - 1);
  const maxFieldPxY = Math.max(0, field.heightPx - 1);
  const clampedMinX = clamp(Math.min(minPxX, maxPxX), 0, maxFieldPxX);
  const clampedMinY = clamp(Math.min(minPxY, maxPxY), 0, maxFieldPxY);
  const clampedMaxX = clamp(Math.max(minPxX, maxPxX), 0, maxFieldPxX);
  const clampedMaxY = clamp(Math.max(minPxY, maxPxY), 0, maxFieldPxY);
  return {
    minX: clamp(Math.floor(clampedMinX / field.stepPx), 0, field.widthCells - 1),
    minY: clamp(Math.floor(clampedMinY / field.stepPx), 0, field.heightCells - 1),
    maxX: clamp(Math.floor(clampedMaxX / field.stepPx), 0, field.widthCells - 1),
    maxY: clamp(Math.floor(clampedMaxY / field.stepPx), 0, field.heightCells - 1),
  };
}

export function intersectDirtyRects(
  a: LightFieldDirtyRect | null,
  b: LightFieldDirtyRect | null,
): LightFieldDirtyRect | null {
  if (!a || !b) return null;
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

export interface ComputeLightFieldParams {
  map: {
    pixelToTile: (px: number, py: number) => { x: number; y: number };
    isVisible: (tx: number, ty: number) => boolean;
    /**
     * Optional discovered-check (sub-tile granularity, mirroring `isVisible`).
     * When provided, discovered-but-not-visible cells render at `discoveredLight`
     * instead of full black. Absent ⇒ legacy behavior (explored areas go black).
     */
    isDiscovered?: (tx: number, ty: number) => boolean;
    hasLineOfSight: (px0: number, py0: number, px1: number, py1: number) => boolean;
  };
  field: LightField;
  /**
   * One or more light sources. All sources are accumulated per cell and clamped
   * to 1. The first entry is conventionally the player's torch.
   *
   * For backward compatibility, the old single-source `source` field is still
   * accepted and treated as `sources: [source]` when `sources` is absent.
   */
  sources?: LightSource[];
  /** @deprecated Use `sources` instead. */
  source?: LightSource;
  ambient: number;
  /**
   * Light level for discovered-but-not-visible cells. Clamped to `[0, 1]` and
   * then to `ambient` (so it can never exceed the dimmest visible cell).
   * Defaults to 0 (legacy full-black) when omitted.
   */
  discoveredLight?: number;
  falloffExponent: number;
  dirtyRect?: LightFieldDirtyRect | null;
}

export function computeLightField(params: ComputeLightFieldParams): void {
  const { map, field } = params;
  const ambient = clamp(params.ambient, 0, 1);
  // Never let remembered terrain out-shine the dimmest visible (ambient) cell.
  const discoveredLight = Math.min(clamp(params.discoveredLight ?? 0, 0, 1), ambient);
  const falloffExponent = Math.max(0.1, params.falloffExponent);
  const step = field.stepPx;

  // Resolve sources: prefer the new `sources` array, fall back to legacy `source`.
  const sources: readonly LightSource[] =
    params.sources !== undefined && params.sources.length > 0
      ? params.sources
      : params.source !== undefined
        ? [params.source]
        : [];

  const bounds = params.dirtyRect ?? {
    minX: 0,
    minY: 0,
    maxX: field.widthCells - 1,
    maxY: field.heightCells - 1,
  };

  for (let cy = bounds.minY; cy <= bounds.maxY; cy++) {
    for (let cx = bounds.minX; cx <= bounds.maxX; cx++) {
      const idx = cy * field.widthCells + cx;
      const sx = Math.min(field.widthPx - 1, cx * step + step * 0.5);
      const sy = Math.min(field.heightPx - 1, cy * step + step * 0.5);
      const tile = map.pixelToTile(sx, sy);
      if (!map.isVisible(tile.x, tile.y)) {
        // Discovered-but-not-visible cells render at a dim memory level (already
        // clamped to ambient) so explored terrain doesn't go fully black.
        field.values[idx] =
          discoveredLight > 0 && map.isDiscovered?.(tile.x, tile.y) ? discoveredLight : 0;
        continue;
      }
      let intensity = ambient;
      for (const source of sources) {
        const radius = Math.max(0, source.radiusPx);
        if (radius > 0 && source.intensity > 0) {
          const dx = sx - source.x;
          const dy = sy - source.y;
          const distance = Math.hypot(dx, dy);
          if (distance <= radius && map.hasLineOfSight(source.x, source.y, sx, sy)) {
            const t = clamp(1 - distance / radius, 0, 1);
            intensity += source.intensity * Math.pow(t, falloffExponent);
          }
        }
      }
      field.values[idx] = clamp(intensity, 0, 1);
    }
  }
}

export function blurLightField(field: LightField, dirtyRect?: LightFieldDirtyRect | null): void {
  const source = field.values;
  const out = new Float32Array(source.length);
  out.set(source);
  const bounds = dirtyRect ?? {
    minX: 0,
    minY: 0,
    maxX: field.widthCells - 1,
    maxY: field.heightCells - 1,
  };
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      let sum = 0;
      let count = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const sx = x + ox;
          const sy = y + oy;
          if (sx < 0 || sy < 0 || sx >= field.widthCells || sy >= field.heightCells) continue;
          sum += source[sy * field.widthCells + sx] ?? 0;
          count += 1;
        }
      }
      out[y * field.widthCells + x] =
        count > 0 ? sum / count : (source[y * field.widthCells + x] ?? 0);
    }
  }
  field.values.set(out);
}

export function chooseAutoStepPx(currentStepPx: number, tileSizePx: number): number {
  return clampLightingStepPx(currentStepPx * 2, tileSizePx);
}

/**
 * Number of discrete darkness levels used when batching the overlay into
 * horizontal runs. Quantizing the per-cell darkness lets the smooth light
 * falloff collapse into a handful of fill commands per row instead of one fill
 * per cell, while staying visually indistinguishable for an alpha shadow
 * overlay.
 */
export const LIGHTING_DARKNESS_LEVELS = 32;

/** Darkness at or below this alpha is treated as fully transparent (no fill). */
export const LIGHTING_MIN_DARKNESS = 0.01;

/**
 * Walk `field` within `bounds` and invoke `emit` once per maximal horizontal run
 * of cells that share the same quantized darkness (`1 - light`). Cells whose
 * darkness is at or below `minDarkness` are skipped and break the current run,
 * so transparent regions cost nothing.
 *
 * This is the batching that keeps the overlay cheap at fine granularity: instead
 * of one fill per lit cell (hundreds of thousands at `stepPx = 1` across the
 * light circle), uniform regions collapse to a single fill and the lit gradient
 * coalesces into at most `levels` fills per row.
 *
 * Pure and deterministic: output depends only on `field.values`, `bounds`, and
 * the numeric parameters — no `Math.random` / `Date.now`.
 */
export function forEachDarknessRun(
  field: LightField,
  bounds: LightFieldDirtyRect,
  levels: number,
  minDarkness: number,
  emit: (cellX: number, cellY: number, lengthCells: number, darkness: number) => void,
): void {
  const safeLevels = Math.max(1, Math.round(levels));
  const width = field.widthCells;
  const minX = clamp(bounds.minX, 0, Math.max(0, width - 1));
  const maxX = clamp(bounds.maxX, 0, Math.max(0, width - 1));
  const minY = clamp(bounds.minY, 0, Math.max(0, field.heightCells - 1));
  const maxY = clamp(bounds.maxY, 0, Math.max(0, field.heightCells - 1));

  for (let y = minY; y <= maxY; y++) {
    let runStart = -1;
    let runDarkness = 0;
    for (let x = minX; x <= maxX; x++) {
      const light = clamp(field.values[y * width + x] ?? 0, 0, 1);
      const darkness = 1 - light;
      const quant =
        darkness <= minDarkness ? 0 : Math.min(1, Math.round(darkness * safeLevels) / safeLevels);
      if (runStart >= 0 && quant === runDarkness) {
        continue;
      }
      if (runStart >= 0) {
        emit(runStart, y, x - runStart, runDarkness);
      }
      if (quant > 0) {
        runStart = x;
        runDarkness = quant;
      } else {
        runStart = -1;
        runDarkness = 0;
      }
    }
    if (runStart >= 0) {
      emit(runStart, y, maxX + 1 - runStart, runDarkness);
    }
  }
}
