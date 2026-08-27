import { describe, expect, it } from 'vitest';
import {
  STAIRS_TEXTURE_KEY,
  resolveStairsContainFit,
} from '../../src/engine/sprites/stairs-visuals.js';
import type { OpaqueBounds } from '../../src/shared/generated-assets.js';

/** The real measured shape of `the-stairs-var-0`: a full-bleed square tile. */
const STAIRS_BOUNDS: OpaqueBounds = {
  x: 0,
  y: 0,
  width: 512,
  height: 512,
  canvasWidth: 512,
  canvasHeight: 512,
};

describe('STAIRS_TEXTURE_KEY', () => {
  it('names an approved manifest entry key', () => {
    expect(STAIRS_TEXTURE_KEY).toBe('the-stairs-var-0');
  });
});

describe('resolveStairsContainFit', () => {
  it('centres the decal on the marker position (floor-plane, not floor-anchored)', () => {
    const fit = resolveStairsContainFit({
      bounds: STAIRS_BOUNDS,
      canvasWidth: 512,
      canvasHeight: 512,
      markerRadiusPx: 100,
    });
    expect(fit.originX).toBeCloseTo(0.5, 6);
    expect(fit.originY).toBeCloseTo(0.5, 6);
  });

  it('contain-fits the square art into the marker footprint (2 * radius per side)', () => {
    const fit = resolveStairsContainFit({
      bounds: STAIRS_BOUNDS,
      canvasWidth: 512,
      canvasHeight: 512,
      markerRadiusPx: 100,
    });
    // Square art into a square footprint: scale should exactly fill both axes.
    expect(fit.scale).toBeCloseTo(200 / 512, 6);
    expect(fit.scale * 512).toBeCloseTo(200, 6);
  });

  it('scales with the marker radius so a bigger objective radius yields bigger art', () => {
    const small = resolveStairsContainFit({
      bounds: STAIRS_BOUNDS,
      canvasWidth: 512,
      canvasHeight: 512,
      markerRadiusPx: 50,
    });
    const large = resolveStairsContainFit({
      bounds: STAIRS_BOUNDS,
      canvasWidth: 512,
      canvasHeight: 512,
      markerRadiusPx: 150,
    });
    expect(large.scale).toBeGreaterThan(small.scale);
    expect(large.scale).toBeCloseTo(small.scale * 3, 6);
  });

  it('falls back to whole-canvas, centred behaviour when bounds are missing', () => {
    const fit = resolveStairsContainFit({
      bounds: undefined,
      canvasWidth: 512,
      canvasHeight: 512,
      markerRadiusPx: 100,
    });
    expect(fit).toEqual({ originX: 0.5, originY: 0.5, scale: 200 / 512 });
  });

  it('never divides by zero on a texture that has not finished loading', () => {
    const fit = resolveStairsContainFit({
      bounds: STAIRS_BOUNDS,
      canvasWidth: 0,
      canvasHeight: 0,
      markerRadiusPx: 100,
    });
    expect(fit).toEqual({ originX: 0.5, originY: 0.5, scale: 1 });
  });
});
