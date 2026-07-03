import { describe, expect, it } from 'vitest';
import {
  computeTextResolution,
  computeUiScale,
  fitScaleForBox,
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

describe('fitScaleForBox', () => {
  // InventoryUI fits item icons into ~75% of a 64px cell.
  const ICON_BOX = 64 * 0.75; // = 48

  it('keeps the 16x16 placeholder at its crisp integer upscale (unchanged)', () => {
    // Matches the pre-fix behaviour for the ONLY size the old `/16` formula was
    // ever correct for: round(48/16) = 3 → 48px, exactly filling the target.
    expect(fitScaleForBox(16, 16, ICON_BOX)).toBe(3);
  });

  it('shrinks 64x64 generated art down to fit the cell (the fix)', () => {
    // 48 / 64 = 0.75 → 64 * 0.75 = 48px, contained in the cell instead of the
    // 192px overflow the old hardcoded /16 produced.
    expect(fitScaleForBox(64, 64, ICON_BOX)).toBe(0.75);
  });

  it('snaps intermediate sizes to the largest integer scale that still fits', () => {
    // 48 / 32 = 1.5 → floor → 1 (32px, crisp) rather than a blurry 1.5x upscale.
    expect(fitScaleForBox(32, 32, ICON_BOX)).toBe(1);
    // 48 / 24 = 2.0 → 2 (48px).
    expect(fitScaleForBox(24, 24, ICON_BOX)).toBe(2);
  });

  it('never lets the scaled sprite overflow the target box', () => {
    for (const size of [8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) {
      const scale = fitScaleForBox(size, size, ICON_BOX);
      expect(scale).toBeGreaterThan(0);
      expect(size * scale).toBeLessThanOrEqual(ICON_BOX + 1e-9);
    }
  });

  it('contains non-square art by fitting its longest side', () => {
    // Longest side = 64 → scale 0.75; both axes stay within the box.
    const scale = fitScaleForBox(64, 32, ICON_BOX);
    expect(scale).toBe(0.75);
    expect(64 * scale).toBeLessThanOrEqual(ICON_BOX + 1e-9);
    expect(32 * scale).toBeLessThanOrEqual(ICON_BOX + 1e-9);
  });

  it('falls back to 1 for degenerate dimensions', () => {
    expect(fitScaleForBox(0, 0, ICON_BOX)).toBe(1);
    expect(fitScaleForBox(16, 16, 0)).toBe(1);
    expect(fitScaleForBox(Number.NaN, 16, ICON_BOX)).toBe(1);
    expect(fitScaleForBox(-32, -32, ICON_BOX)).toBe(1);
  });

  it('fixes the InventoryUI icon-overflow bug (before/after witness)', () => {
    // BEFORE: the old render path scaled EVERY icon by a hardcoded /16, so a
    // 64x64 approved sprite rendered at 3x = 192px, ~3x the 64px cell.
    const oldFixed16Scale = Math.max(1, Math.round(ICON_BOX / 16)); // = 3
    expect(64 * oldFixed16Scale).toBe(192);
    expect(64 * oldFixed16Scale).toBeGreaterThan(64); // overflows the cell

    // AFTER: fitScaleForBox reads the real 64x64 source and lands it at 48px —
    // inside the cell, with the rarity border still visible.
    const newScale = fitScaleForBox(64, 64, ICON_BOX);
    expect(64 * newScale).toBe(ICON_BOX);
    expect(64 * newScale).toBeLessThanOrEqual(64);
  });
});
