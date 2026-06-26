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
  const design = { designWidth: 1280, designHeight: 720 };

  it('renders at native resolution when the canvas is shown at design size on a 1x display', () => {
    expect(computeTextResolution(1280, 720, 1, design)).toBe(1);
  });

  it('bumps resolution by the FIT magnification so upscaled glyphs stay crisp', () => {
    // 1280x720 design shown at 1920x1080 → 1.5x FIT magnification (the cause of
    // the blurry HUD text). Resolution must round up past 1 to compensate.
    expect(computeTextResolution(1920, 1080, 1, design)).toBe(2);
    expect(computeTextResolution(2560, 1440, 1, design)).toBe(2);
  });

  it('accounts for the device pixel ratio (HiDPI / OS scaling / browser zoom)', () => {
    expect(computeTextResolution(1280, 720, 2, design)).toBe(2);
    expect(computeTextResolution(1920, 1080, 2, design)).toBe(3);
  });

  it('uses the limiting (smallest-magnification) axis like Phaser.Scale.FIT', () => {
    // Width magnifies 1.5x but height only 1x → FIT scales by 1x, so resolution stays 1.
    expect(computeTextResolution(1920, 720, 1, design)).toBe(1);
  });

  it('keeps text crisp when a responsive container scales it up on small screens', () => {
    // Canvas minified to 0.5x but the HUD group scales text up by 2x → needs 2x glyphs.
    expect(computeTextResolution(640, 360, 1, { ...design, responsiveScale: 2 })).toBe(2);
  });

  it('clamps to the maximum resolution on extreme displays', () => {
    expect(computeTextResolution(3840, 2160, 3, design)).toBe(MAX_TEXT_RESOLUTION);
    expect(computeTextResolution(3840, 2160, 1, { ...design, max: 6 })).toBe(3);
  });

  it('treats a non-positive device pixel ratio as 1', () => {
    expect(computeTextResolution(1920, 1080, 0, design)).toBe(2);
    expect(computeTextResolution(1280, 720, Number.NaN, design)).toBe(1);
  });

  it('falls back to native resolution for degenerate display sizes', () => {
    expect(computeTextResolution(0, 0, 2, design)).toBe(1);
    expect(computeTextResolution(Number.NaN, 100, 2, design)).toBe(1);
  });
});
