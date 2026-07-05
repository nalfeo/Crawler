import { afterEach, describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import {
  computeOnScreenScale,
  computeRenderScale,
  getOnScreenScale,
  getRenderScale,
  MAX_RENDER_SCALE,
  readDevicePixelRatio,
  resolveBootRenderScale,
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

describe('computeOnScreenScale', () => {
  const design = { designWidth: 1280, designHeight: 720 };

  it('is 1 on a 1× display at the design size', () => {
    expect(computeOnScreenScale(1280, 720, 1, design)).toBe(1);
  });

  it('keeps the continuous magnification the integer render scale rounds away', () => {
    // 1600×900 ÷ 1280×720 = 1.25× FIT magnification at dpr 1. computeRenderScale
    // rounds this to S=1, but the canvas is still FIT-upscaled 1.25× — the residual
    // computeOnScreenScale must preserve so text can oversample it.
    expect(computeOnScreenScale(1600, 900, 1, design)).toBeCloseTo(1.25, 5);
    expect(computeRenderScale(1600, 900, 1, design)).toBe(1);
  });

  it('multiplies the FIT magnification by the device pixel ratio', () => {
    expect(computeOnScreenScale(1280, 720, 2, design)).toBe(2);
    expect(computeOnScreenScale(1920, 1080, 2, design)).toBe(3); // 1.5 × 2 — unclamped
  });

  it('uses the limiting (smallest-magnification) axis like Phaser.Scale.FIT', () => {
    expect(computeOnScreenScale(1920, 720, 1, design)).toBe(1);
  });

  it('treats a non-positive device pixel ratio as 1 and degenerate sizes as 1', () => {
    expect(computeOnScreenScale(1600, 900, 0, design)).toBeCloseTo(1.25, 5);
    expect(computeOnScreenScale(0, 0, 2, design)).toBe(1);
    expect(computeOnScreenScale(Number.NaN, 100, 2, design)).toBe(1);
  });
});

describe('getOnScreenScale', () => {
  const sceneWith = (
    displaySize: { width: number; height: number } | undefined,
    width = 1280,
  ): Phaser.Scene => ({ scale: { width, displaySize } }) as unknown as Phaser.Scene;

  it('derives the continuous magnification from the canvas CSS display size', () => {
    // dpr defaults to 1 outside a DOM (readDevicePixelRatio falls back to 1).
    expect(getOnScreenScale(sceneWith({ width: 1600, height: 900 }))).toBeCloseTo(1.25, 5);
    expect(getOnScreenScale(sceneWith({ width: 1280, height: 720 }))).toBe(1);
  });

  it('falls back to the integer render scale when the display size is unknown', () => {
    expect(getOnScreenScale(sceneWith(undefined, 2560))).toBe(2);
    expect(getOnScreenScale(sceneWith({ width: 0, height: 0 }, 1280))).toBe(1);
  });
});

describe('readDevicePixelRatio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 1 when window is not defined (node env)', () => {
    // In the node test environment window is undefined — the fallback kicks in.
    expect(readDevicePixelRatio()).toBe(1);
  });

  it('returns the devicePixelRatio from window when positive', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    expect(readDevicePixelRatio()).toBe(2);
  });

  it('falls back to 1 when window.devicePixelRatio is 0 or negative', () => {
    vi.stubGlobal('window', { devicePixelRatio: 0 });
    expect(readDevicePixelRatio()).toBe(1);
  });
});

describe('resolveBootRenderScale', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 1 when window is not defined (node env)', () => {
    expect(resolveBootRenderScale(null)).toBe(1);
  });

  it('uses window.innerWidth/Height when no parent is provided', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080 });
    vi.stubGlobal('document', { getElementById: () => null });
    // 1920×1080 / 1280×720 = 1.5 FIT magnification at dpr 1 → rounds to 2
    expect(resolveBootRenderScale(null)).toBe(2);
  });

  it('uses the parent element clientWidth/Height when an HTMLElement is passed', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080 });
    vi.stubGlobal('document', { getElementById: () => null });
    const fakeEl = { clientWidth: 1280, clientHeight: 720 } as HTMLElement;
    // Exact design size → scale 1
    expect(resolveBootRenderScale(fakeEl)).toBe(1);
  });

  it('resolves parent string id via document.getElementById', () => {
    const fakeEl = { clientWidth: 2560, clientHeight: 1440 };
    vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 800, innerHeight: 600 });
    vi.stubGlobal('document', { getElementById: () => fakeEl });
    // 2560×1440 / 1280×720 = 2× → scale 2
    expect(resolveBootRenderScale('game-container')).toBe(MAX_RENDER_SCALE);
  });
});
