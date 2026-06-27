import { describe, expect, it } from 'vitest';
import {
  clampLightingStepPx,
  computeLightField,
  createLightField,
  forEachDarknessRun,
  LIGHTING_DARKNESS_LEVELS,
  LIGHTING_MIN_DARKNESS,
  type ComputeLightFieldParams,
} from '../../src/engine/lighting/light-field';

function runCompute(
  partial: Omit<ComputeLightFieldParams, 'field'> & {
    stepPx: number;
    widthPx: number;
    heightPx: number;
  },
) {
  const field = createLightField(partial.widthPx, partial.heightPx, partial.stepPx);
  computeLightField({
    map: partial.map,
    field,
    source: partial.source,
    ambient: partial.ambient,
    falloffExponent: partial.falloffExponent,
  });
  return field;
}

describe('light-field', () => {
  it('clamps stepPx from tile-size down to 1px', () => {
    expect(clampLightingStepPx(0, 32)).toBe(1);
    expect(clampLightingStepPx(1, 32)).toBe(1);
    expect(clampLightingStepPx(32, 32)).toBe(32);
    expect(clampLightingStepPx(64, 32)).toBe(32);
  });

  it('maps stepPx to expected buffer dimensions', () => {
    expect(createLightField(64, 64, 32).values.length).toBe(4);
    expect(createLightField(64, 64, 16).values.length).toBe(16);
    expect(createLightField(64, 64, 1).values.length).toBe(4096);
  });

  it('is deterministic for the same inputs', () => {
    const map: ComputeLightFieldParams['map'] = {
      pixelToTile: (px, py) => ({ x: Math.floor(px / 16), y: Math.floor(py / 16) }),
      isVisible: () => true,
      hasLineOfSight: () => true,
    };
    const a = runCompute({
      map,
      stepPx: 4,
      widthPx: 64,
      heightPx: 64,
      source: { x: 32, y: 32, radiusPx: 30, intensity: 1 },
      ambient: 0.05,
      falloffExponent: 1.6,
    });
    const b = runCompute({
      map,
      stepPx: 4,
      widthPx: 64,
      heightPx: 64,
      source: { x: 32, y: 32, radiusPx: 30, intensity: 1 },
      ambient: 0.05,
      falloffExponent: 1.6,
    });
    expect(Array.from(a.values)).toEqual(Array.from(b.values));
  });

  it('honors occlusion callback', () => {
    const blocked = runCompute({
      map: {
        pixelToTile: (px, py) => ({ x: Math.floor(px / 16), y: Math.floor(py / 16) }),
        isVisible: () => true,
        hasLineOfSight: (_x0, _y0, x1) => x1 < 32,
      },
      stepPx: 8,
      widthPx: 64,
      heightPx: 64,
      source: { x: 8, y: 32, radiusPx: 80, intensity: 1 },
      ambient: 0,
      falloffExponent: 1,
    });
    const litLeft = blocked.values[4 * blocked.widthCells + 1] ?? 0;
    const darkRight = blocked.values[4 * blocked.widthCells + 6] ?? 0;
    expect(litLeft).toBeGreaterThan(0.2);
    expect(darkRight).toBe(0);
  });
});

describe('forEachDarknessRun', () => {
  function collectRuns(
    light: number[],
    widthCells: number,
    heightCells: number,
    levels = LIGHTING_DARKNESS_LEVELS,
  ): Array<{ x: number; y: number; len: number; darkness: number }> {
    const field = createLightField(widthCells, heightCells, 1);
    field.values.set(light);
    const runs: Array<{ x: number; y: number; len: number; darkness: number }> = [];
    forEachDarknessRun(
      field,
      { minX: 0, minY: 0, maxX: widthCells - 1, maxY: heightCells - 1 },
      levels,
      LIGHTING_MIN_DARKNESS,
      (x, y, len, darkness) => runs.push({ x, y, len, darkness }),
    );
    return runs;
  }

  it('emits nothing for a fully lit field', () => {
    expect(collectRuns([1, 1, 1, 1], 4, 1)).toEqual([]);
  });

  it('collapses a uniform dark row into a single run', () => {
    const runs = collectRuns([0, 0, 0, 0], 4, 1);
    expect(runs).toEqual([{ x: 0, y: 0, len: 4, darkness: 1 }]);
  });

  it('skips lit cells and breaks runs around them', () => {
    // light: dark, dark, lit, dark → two separate runs around the lit gap
    const runs = collectRuns([0, 0, 1, 0], 4, 1);
    expect(runs).toEqual([
      { x: 0, y: 0, len: 2, darkness: 1 },
      { x: 3, y: 0, len: 1, darkness: 1 },
    ]);
  });

  it('coalesces near-equal darkness via quantization', () => {
    // darkness 0.50 and 0.51 both quantize to the same 32-level bucket.
    const runs = collectRuns([0.5, 0.49], 2, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ x: 0, y: 0, len: 2 });
  });

  it('splits distinct darkness levels into separate runs', () => {
    // darkness 0.5 vs 0.9 land in different buckets.
    const runs = collectRuns([0.5, 0.1], 2, 1);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.x).toBe(0);
    expect(runs[1]!.x).toBe(1);
    expect(runs[0]!.darkness).not.toBe(runs[1]!.darkness);
  });

  it('processes each row independently and conserves dark-cell coverage', () => {
    // Row 0 fully dark, row 1 fully lit.
    const runs = collectRuns([0, 0, 0, 1, 1, 1], 3, 2);
    expect(runs).toEqual([{ x: 0, y: 0, len: 3, darkness: 1 }]);
  });

  it('respects bounds and never exceeds the row width', () => {
    const field = createLightField(5, 1, 1);
    field.values.set([0, 0, 0, 0, 0]);
    const runs: Array<{ x: number; len: number }> = [];
    forEachDarknessRun(
      field,
      { minX: 1, minY: 0, maxX: 3, maxY: 0 },
      LIGHTING_DARKNESS_LEVELS,
      LIGHTING_MIN_DARKNESS,
      (x, _y, len) => runs.push({ x, len }),
    );
    expect(runs).toEqual([{ x: 1, len: 3 }]);
  });
});
