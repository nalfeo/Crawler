export const LIGHTING_PRESET_STEPS = {
  tile: 32,
  halfTile: 16,
  quarterTile: 8,
  pixel: 1,
} as const;

export type LightingPresetId = keyof typeof LIGHTING_PRESET_STEPS;

export interface LightingConfig {
  stepPx: number;
  ambient: number;
  sourceRadiusPx: number;
  sourceIntensity: number;
  falloffExponent: number;
  softness: boolean;
  updateEveryNFrames: number;
  autoAdjustQuality: boolean;
  targetComputeMs: number;
}

export const DEFAULT_LIGHTING_CONFIG: LightingConfig = {
  stepPx: LIGHTING_PRESET_STEPS.quarterTile,
  ambient: 0.08,
  sourceRadiusPx: 320,
  sourceIntensity: 0.95,
  falloffExponent: 1.6,
  softness: false,
  updateEveryNFrames: 1,
  autoAdjustQuality: true,
  targetComputeMs: 3.5,
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

export interface ComputeLightFieldParams {
  map: {
    pixelToTile: (px: number, py: number) => { x: number; y: number };
    isVisible: (tx: number, ty: number) => boolean;
    hasLineOfSight: (px0: number, py0: number, px1: number, py1: number) => boolean;
  };
  field: LightField;
  source: LightSource;
  ambient: number;
  falloffExponent: number;
  dirtyRect?: LightFieldDirtyRect | null;
}

export function computeLightField(params: ComputeLightFieldParams): void {
  const { map, field, source } = params;
  const ambient = clamp(params.ambient, 0, 1);
  const falloffExponent = Math.max(0.1, params.falloffExponent);
  const step = field.stepPx;
  const radius = Math.max(0, source.radiusPx);
  const invRadius = radius > 0 ? 1 / radius : 0;

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
        field.values[idx] = 0;
        continue;
      }
      let intensity = ambient;
      if (radius > 0 && source.intensity > 0) {
        const dx = sx - source.x;
        const dy = sy - source.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= radius && map.hasLineOfSight(source.x, source.y, sx, sy)) {
          const t = clamp(1 - distance * invRadius, 0, 1);
          intensity += source.intensity * Math.pow(t, falloffExponent);
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
