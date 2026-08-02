/**
 * Unit coverage for the pure safe-area inset math (`src/engine/safe-area.ts`).
 *
 * The reference device is an iPhone 13 Pro in landscape: 2532×1170 physical =
 * 844×390 CSS px at DPR 3, with `env(safe-area-inset-*)` reporting a 47px notch
 * band on one long edge and a 21px home-indicator band at the bottom. Under
 * `Phaser.Scale.FIT` the 16:9 canvas pillarboxes to ~693.33×390 at x≈75, so the
 * notch band lands entirely in the black bar while the home-indicator band
 * covers the full canvas bottom. These cases pin exactly that asymmetry.
 */
import { describe, expect, it } from 'vitest';
import {
  ZERO_SAFE_AREA_INSETS,
  computeDesignSafeInsets,
  type SafeAreaInsets,
} from '../../src/engine/safe-area.js';

/** iPhone 13 Pro landscape, header hidden — measured from the real lab canvas. */
const IPHONE_13_PRO_LANDSCAPE = {
  viewport: { width: 844, height: 390 },
  canvas: { x: 75, y: 0, width: 693.328125, height: 390 },
  insets: { top: 0, right: 47, bottom: 21, left: 47 } satisfies SafeAreaInsets,
};

/** Design pixels per CSS pixel on the reference device's tightest axis. */
const DESIGN_PER_CSS = 720 / 390;

describe('computeDesignSafeInsets', () => {
  it('absorbs the iPhone notch bands in the pillarbox and keeps only the bottom band', () => {
    const insets = computeDesignSafeInsets(IPHONE_13_PRO_LANDSCAPE);

    // 47px notch < 75px pillarbox on both long edges — costs the UI nothing.
    expect(insets.left).toBe(0);
    expect(insets.right).toBe(0);
    expect(insets.top).toBe(0);
    // 21 CSS px of home indicator over a 390px-tall canvas = ~38.8 design px.
    expect(insets.bottom).toBeCloseTo(21 * DESIGN_PER_CSS, 5);
  });

  it('returns zero insets on a desktop viewport with no cutout', () => {
    const insets = computeDesignSafeInsets({
      viewport: { width: 1600, height: 900 },
      canvas: { x: 0, y: 0, width: 1600, height: 900 },
      insets: ZERO_SAFE_AREA_INSETS,
    });

    expect(insets).toEqual(ZERO_SAFE_AREA_INSETS);
  });

  it('converts overlapping bands to design pixels on an edge-to-edge canvas', () => {
    // A canvas filling a 16:9 viewport exactly: every band overlaps it fully.
    const insets = computeDesignSafeInsets({
      viewport: { width: 640, height: 360 },
      canvas: { x: 0, y: 0, width: 640, height: 360 },
      insets: { top: 5, right: 10, bottom: 20, left: 15 },
    });

    // 1280/640 = 2 design px per CSS px on X, 720/360 = 2 on Y.
    expect(insets).toEqual({ top: 10, right: 20, bottom: 40, left: 30 });
  });

  it('counts only the portion of a band that actually overlaps the canvas', () => {
    // Canvas inset 10px from the left; a 15px band leaves 5px of real overlap.
    const insets = computeDesignSafeInsets({
      viewport: { width: 660, height: 360 },
      canvas: { x: 10, y: 0, width: 640, height: 360 },
      insets: { top: 0, right: 0, bottom: 0, left: 15 },
    });

    expect(insets.left).toBe(10); // 5 CSS px × 2 design px/CSS px
  });

  it('never returns a negative inset when a band misses the canvas entirely', () => {
    // Canvas pillarboxed by 180px on each side and letterboxed 50px from the
    // top, so the 100px side bands and the 40px top band all fall outside it.
    const insets = computeDesignSafeInsets({
      viewport: { width: 1000, height: 460 },
      canvas: { x: 180, y: 50, width: 640, height: 360 },
      insets: { top: 40, right: 100, bottom: 0, left: 100 },
    });

    expect(insets).toEqual(ZERO_SAFE_AREA_INSETS);
  });

  it('clamps a band that swallows the canvas to the design size', () => {
    const insets = computeDesignSafeInsets({
      viewport: { width: 640, height: 360 },
      canvas: { x: 0, y: 0, width: 640, height: 360 },
      insets: { top: 0, right: 0, bottom: 9999, left: 0 },
    });

    expect(insets.bottom).toBe(720);
  });

  it('treats a degenerate (pre-layout) canvas as fully safe', () => {
    const insets = computeDesignSafeInsets({
      viewport: { width: 844, height: 390 },
      canvas: { x: 0, y: 0, width: 0, height: 0 },
      insets: { top: 47, right: 47, bottom: 21, left: 47 },
    });

    expect(insets).toEqual(ZERO_SAFE_AREA_INSETS);
  });

  it('ignores NaN / negative inset values from an unresolved CSS variable', () => {
    const insets = computeDesignSafeInsets({
      viewport: { width: 640, height: 360 },
      canvas: { x: 0, y: 0, width: 640, height: 360 },
      insets: { top: Number.NaN, right: -20, bottom: 20, left: Number.NaN },
    });

    expect(insets).toEqual({ top: 0, right: 0, bottom: 40, left: 0 });
  });

  it('honours a custom design space', () => {
    const insets = computeDesignSafeInsets({
      viewport: { width: 400, height: 200 },
      canvas: { x: 0, y: 0, width: 400, height: 200 },
      insets: { top: 0, right: 0, bottom: 10, left: 0 },
      designWidth: 800,
      designHeight: 400,
    });

    expect(insets.bottom).toBe(20);
  });
});
