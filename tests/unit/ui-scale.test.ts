import { describe, expect, it } from 'vitest';
import { computeUiScale, MAX_UI_SCALE, MIN_UI_SCALE } from '../../src/engine/ui-scale.js';

describe('computeUiScale', () => {
  const design = { designWidth: 1280, designHeight: 720 };

  it('keeps the authored scale on desktop-sized canvases', () => {
    // Canvas displayed at or above the design size: no upscaling.
    expect(computeUiScale(1280, 720, design)).toBe(1);
    expect(computeUiScale(1920, 1080, design)).toBe(1);
  });

  it('scales up when the canvas is displayed smaller than the design size', () => {
    // 640px wide → 1280/640 = 2x on the width axis.
    expect(computeUiScale(640, 360, design)).toBe(2);
  });

  it('uses the tightest (largest-shrink) axis', () => {
    // Width shrink 1280/800 = 1.6, height shrink 720/360 = 2.0 → picks 2.0.
    expect(computeUiScale(800, 360, design)).toBe(2);
  });

  it('clamps to the maximum scale on very small screens', () => {
    expect(computeUiScale(200, 120, design)).toBe(MAX_UI_SCALE);
  });

  it('never returns below the minimum scale', () => {
    expect(computeUiScale(5000, 5000, design)).toBe(MIN_UI_SCALE);
  });

  it('falls back to the minimum scale for degenerate sizes', () => {
    expect(computeUiScale(0, 0, design)).toBe(MIN_UI_SCALE);
    expect(computeUiScale(Number.NaN, 100, design)).toBe(MIN_UI_SCALE);
  });

  it('rounds to two decimals to avoid resize churn', () => {
    // 1280/933 ≈ 1.3719... → 1.37
    expect(computeUiScale(933, 720, design)).toBe(1.37);
  });

  it('honours custom min/max overrides', () => {
    expect(computeUiScale(640, 360, { ...design, max: 1.5 })).toBe(1.5);
    expect(computeUiScale(1920, 1080, { ...design, min: 1.2 })).toBe(1.2);
  });
});
