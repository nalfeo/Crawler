import { describe, expect, it } from 'vitest';
import {
  computeTextResolution,
  computeUiScale,
  MAX_TEXT_RESOLUTION,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
} from '../../src/engine/ui-scale.js';

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

describe('computeTextResolution', () => {
  it('renders at native resolution at on-screen scale 1 with no UI upscaling', () => {
    expect(computeTextResolution(1, 1)).toBe(1);
  });

  it('matches the HiDPI render scale so supersampled glyphs stay crisp', () => {
    // The UI camera renders the design space into a 2× framebuffer, so text must
    // be rasterised at 2× to fill its footprint instead of being upscaled.
    expect(computeTextResolution(2, 1)).toBe(2);
  });

  it('accounts for a responsive UI scale on small screens', () => {
    // On-screen scale 1, but the HUD group scales text up 2× → needs 2× glyphs.
    expect(computeTextResolution(1, 2)).toBe(2);
  });

  it('oversamples the residual FIT magnification the integer render scale drops', () => {
    // A dpr=1 canvas shown ~1.25× larger than the design size: the framebuffer S
    // rounds to 1, but the glyph is still FIT-upscaled ~1.25×. ceil keeps it crisp
    // (PR #342's complementary layer); the old round(S × uiScale) gave 1 (soft).
    expect(computeTextResolution(1.25, 1)).toBe(2);
    expect(computeTextResolution(1.2, 1)).toBe(2);
  });

  it('combines the on-screen scale and the UI scale', () => {
    expect(computeTextResolution(2, 1.37)).toBe(3); // ceil(2.74)
  });

  it('rounds fractional resolutions up to avoid undersampling', () => {
    expect(computeTextResolution(1, 1.4)).toBe(2); // ceil(1.4)
    expect(computeTextResolution(1, 1.6)).toBe(2); // ceil(1.6)
  });

  it('clamps to the maximum resolution', () => {
    expect(computeTextResolution(2, 4)).toBe(MAX_TEXT_RESOLUTION); // ceil(8) → 4
    expect(computeTextResolution(2, 4, { max: 6 })).toBe(6);
  });

  it('treats non-positive inputs as 1', () => {
    expect(computeTextResolution(0, 1)).toBe(1);
    expect(computeTextResolution(2, 0)).toBe(2); // uiScale → 1, ceil(2)
    expect(computeTextResolution(Number.NaN, 1)).toBe(1);
    expect(computeTextResolution(1, Number.NaN)).toBe(1);
  });
});
