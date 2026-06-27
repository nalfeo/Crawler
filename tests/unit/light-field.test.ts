import { describe, expect, it } from 'vitest';
import {
  clampLightingStepPx,
  computeLightField,
  createLightField,
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
