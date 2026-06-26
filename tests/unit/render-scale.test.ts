import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';
import {
  computeRenderScale,
  getRenderScale,
  MAX_RENDER_SCALE,
} from '../../src/engine/render-scale.js';

describe('computeRenderScale', () => {
  const design = { designWidth: 1280, designHeight: 720 };

  it('is a no-op (scale 1) on a 1× display at the design size', () => {
    expect(computeRenderScale(1280, 720, 1, design)).toBe(1);
  });

  it('is a no-op (scale 1) on a 1× display smaller than the design size', () => {
    expect(computeRenderScale(960, 540, 1, design)).toBe(1);
    expect(computeRenderScale(400, 300, 1, design)).toBe(1);
  });

  it('supersamples a HiDPI (devicePixelRatio 2) display', () => {
    expect(computeRenderScale(1280, 720, 2, design)).toBe(2);
    // The reported bug: ~1.06× CSS magnification × dpr 2 → 2.
    expect(computeRenderScale(1360, 765, 2, design)).toBe(2);
  });

  it('supersamples a large 1× display shown above the design size', () => {
    // 1920×1080 ÷ 1280×720 = 1.5× FIT magnification → rounds to 2.
    expect(computeRenderScale(1920, 1080, 1, design)).toBe(2);
  });

  it('uses the limiting (smallest-magnification) axis like Phaser.Scale.FIT', () => {
    // Width magnifies 1.5× but height only 1× → FIT scales by 1× → no supersample.
    expect(computeRenderScale(1920, 720, 1, design)).toBe(1);
  });

  it('clamps to the maximum render scale', () => {
    expect(computeRenderScale(1920, 1080, 2, design)).toBe(MAX_RENDER_SCALE); // 3 → 2
    expect(computeRenderScale(3840, 2160, 3, design)).toBe(MAX_RENDER_SCALE);
  });

  it('honours a custom maximum', () => {
    expect(computeRenderScale(1920, 1080, 2, { ...design, max: 3 })).toBe(3);
  });

  it('treats a non-positive device pixel ratio as 1', () => {
    expect(computeRenderScale(1920, 1080, 0, design)).toBe(2);
    expect(computeRenderScale(1280, 720, Number.NaN, design)).toBe(1);
  });

  it('falls back to scale 1 for degenerate display sizes', () => {
    expect(computeRenderScale(0, 0, 2, design)).toBe(1);
    expect(computeRenderScale(Number.NaN, 100, 2, design)).toBe(1);
  });
});

describe('getRenderScale', () => {
  const sceneWith = (width: number): Phaser.Scene =>
    ({ scale: { width } }) as unknown as Phaser.Scene;

  it('recovers the integer scale the game was sized at (design × S)', () => {
    expect(getRenderScale(sceneWith(1280))).toBe(1);
    expect(getRenderScale(sceneWith(2560))).toBe(2);
  });

  it('rounds sub-integer ratios from float noise', () => {
    expect(getRenderScale(sceneWith(2559))).toBe(2);
  });

  it('never returns below 1 for sub-design sizes', () => {
    expect(getRenderScale(sceneWith(640))).toBe(1);
    expect(getRenderScale(sceneWith(0))).toBe(1);
  });
});
