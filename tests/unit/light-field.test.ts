import { describe, expect, it } from 'vitest';
import {
  blurLightField,
  buildDirtyRectFromCircles,
  buildDirtyRectFromPixelBounds,
  chooseAutoStepPx,
  clampLightingStepPx,
  computeLightField,
  createLightField,
  forEachDarknessRun,
  getLightingPresetStepPx,
  intersectDirtyRects,
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

describe('chooseAutoStepPx', () => {
  it('doubles the current step', () => {
    expect(chooseAutoStepPx(1, 32)).toBe(2);
    expect(chooseAutoStepPx(8, 32)).toBe(16);
  });

  it('never exceeds the tile size', () => {
    expect(chooseAutoStepPx(16, 32)).toBe(32);
    expect(chooseAutoStepPx(32, 32)).toBe(32);
    expect(chooseAutoStepPx(20, 32)).toBe(32);
  });

  it('stays at least 1', () => {
    expect(chooseAutoStepPx(1, 1)).toBe(1);
  });
});

describe('getLightingPresetStepPx', () => {
  it('maps presets to their pixel step at full tile size', () => {
    expect(getLightingPresetStepPx('tile', 32)).toBe(32);
    expect(getLightingPresetStepPx('halfTile', 32)).toBe(16);
    expect(getLightingPresetStepPx('quarterTile', 32)).toBe(8);
    expect(getLightingPresetStepPx('pixel', 32)).toBe(1);
  });

  it('clamps coarse presets down to a smaller tile size', () => {
    // A preset coarser than the tile cannot exceed one tile.
    expect(getLightingPresetStepPx('tile', 8)).toBe(8);
    expect(getLightingPresetStepPx('halfTile', 8)).toBe(8);
    expect(getLightingPresetStepPx('quarterTile', 8)).toBe(8);
    expect(getLightingPresetStepPx('pixel', 8)).toBe(1);
  });
});

describe('buildDirtyRectFromCircles', () => {
  // 100x100 px field, 10px cells -> 10x10 cells.
  const field = createLightField(100, 100, 10);

  it('returns null when there are no circles', () => {
    expect(buildDirtyRectFromCircles(field, [])).toBeNull();
  });

  describe('buildDirtyRectFromPixelBounds', () => {
    const field = createLightField(100, 80, 10); // 10x8 cells

    it('maps pixel bounds to cell bounds', () => {
      expect(buildDirtyRectFromPixelBounds(field, 12, 9, 38, 41)).toEqual({
        minX: 1,
        minY: 0,
        maxX: 3,
        maxY: 4,
      });
    });

    it('clamps out-of-bounds coordinates', () => {
      expect(buildDirtyRectFromPixelBounds(field, -100, -100, 1000, 1000)).toEqual({
        minX: 0,
        minY: 0,
        maxX: 9,
        maxY: 7,
      });
    });
  });

  describe('intersectDirtyRects', () => {
    it('returns overlap when rects intersect', () => {
      expect(
        intersectDirtyRects(
          { minX: 2, minY: 2, maxX: 6, maxY: 6 },
          { minX: 4, minY: 1, maxX: 8, maxY: 3 },
        ),
      ).toEqual({ minX: 4, minY: 2, maxX: 6, maxY: 3 });
    });

    it('returns null when rects do not overlap', () => {
      expect(
        intersectDirtyRects(
          { minX: 0, minY: 0, maxX: 1, maxY: 1 },
          { minX: 3, minY: 3, maxX: 4, maxY: 4 },
        ),
      ).toBeNull();
    });
  });

  it('maps a zero-radius circle to its single containing cell', () => {
    expect(buildDirtyRectFromCircles(field, [{ x: 50, y: 50, radiusPx: 0 }])).toEqual({
      minX: 5,
      minY: 5,
      maxX: 5,
      maxY: 5,
    });
  });

  it('rounds pixel extents down to cell indices', () => {
    // 25px -> floor(25/10) = cell 2.
    expect(buildDirtyRectFromCircles(field, [{ x: 25, y: 25, radiusPx: 0 }])).toEqual({
      minX: 2,
      minY: 2,
      maxX: 2,
      maxY: 2,
    });
  });

  it('expands the rect by the circle radius', () => {
    expect(buildDirtyRectFromCircles(field, [{ x: 50, y: 50, radiusPx: 20 }])).toEqual({
      minX: 3,
      minY: 3,
      maxX: 7,
      maxY: 7,
    });
  });

  it('unions multiple circles', () => {
    expect(
      buildDirtyRectFromCircles(field, [
        { x: 10, y: 10, radiusPx: 0 },
        { x: 90, y: 90, radiusPx: 0 },
      ]),
    ).toEqual({ minX: 1, minY: 1, maxX: 9, maxY: 9 });
  });

  it('clamps circles that extend past the field bounds', () => {
    // Far below origin clamps to cell 0; far past the edge clamps to the last cell.
    expect(buildDirtyRectFromCircles(field, [{ x: -100, y: -100, radiusPx: 5 }])).toEqual({
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    });
    expect(buildDirtyRectFromCircles(field, [{ x: 1000, y: 1000, radiusPx: 5 }])).toEqual({
      minX: 9,
      minY: 9,
      maxX: 9,
      maxY: 9,
    });
  });
});

describe('blurLightField', () => {
  it('leaves a uniform field unchanged', () => {
    const field = createLightField(4, 4, 1);
    field.values.fill(0.5);
    blurLightField(field);
    for (const v of field.values) {
      expect(v).toBeCloseTo(0.5, 6);
    }
  });

  it('spreads an isolated spike to its neighbours via a 3x3 average', () => {
    const field = createLightField(3, 3, 1);
    field.values.set([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    blurLightField(field);
    const at = (x: number, y: number) => field.values[y * field.widthCells + x] ?? 0;
    // Center averages all 9 cells; corner 4 cells; edge 6 cells.
    expect(at(1, 1)).toBeCloseTo(1 / 9, 6);
    expect(at(0, 0)).toBeCloseTo(1 / 4, 6);
    expect(at(1, 0)).toBeCloseTo(1 / 6, 6);
  });

  it('only recomputes cells inside the dirty rect', () => {
    const field = createLightField(3, 3, 1);
    field.values.set([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    blurLightField(field, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
    const at = (x: number, y: number) => field.values[y * field.widthCells + x] ?? 0;
    // Only the top-left cell is blurred; the spike at center is untouched.
    expect(at(0, 0)).toBeCloseTo(1 / 4, 6);
    expect(at(1, 1)).toBe(1);
  });
});
