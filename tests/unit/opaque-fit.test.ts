import { describe, expect, it } from 'vitest';
import { resolveOpaqueFit, type OpaqueBounds } from '../../src/shared/generated-assets.js';

/**
 * A 96x91 canvas whose art occupies 86x81 inset by the pipeline's standardized
 * 5px transparent margin — the real measured shape of `welcome-room-bookcase-var-0`.
 */
const BOOKCASE: OpaqueBounds = {
  x: 5,
  y: 5,
  width: 86,
  height: 81,
  canvasWidth: 96,
  canvasHeight: 91,
};

const base = {
  canvasWidth: 96,
  canvasHeight: 91,
  targetWidthPx: 100,
  targetHeightPx: 200,
  anchorBase: true,
  floorPlane: false,
};

describe('resolveOpaqueFit', () => {
  it('anchors a base-anchored prop on the bottom of its ART, not its canvas', () => {
    const fit = resolveOpaqueFit({ ...base, bounds: BOOKCASE });
    // Opaque bottom is y=86 of 91, so the origin sits above the canvas bottom by
    // exactly the transparent margin. Anchoring at 1.0 is what made props float.
    expect(fit.originY).toBeCloseTo(86 / 91, 6);
    expect(fit.originY).toBeLessThan(1);
  });

  it('centres on the art centre, not the canvas centre, when not base-anchored', () => {
    const fit = resolveOpaqueFit({ ...base, bounds: BOOKCASE, anchorBase: false });
    expect(fit.originY).toBeCloseTo((5 + 81 / 2) / 91, 6);
    expect(fit.originX).toBeCloseTo((5 + 86 / 2) / 96, 6);
  });

  it('scales so the VISIBLE height equals the declared height', () => {
    const fit = resolveOpaqueFit({ ...base, bounds: BOOKCASE });
    expect(fit.scale * 81).toBeCloseTo(200, 6);
    // The canvas-relative scale would have rendered the art ~11% short.
    expect(fit.scale).toBeGreaterThan(200 / 91);
  });

  it('contain-fits floor-plane props on both axes so ground extents are honoured', () => {
    const fit = resolveOpaqueFit({ ...base, bounds: BOOKCASE, floorPlane: true });
    expect(fit.scale).toBeCloseTo(Math.min(100 / 86, 200 / 81), 6);
    expect(fit.scale * 86).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('falls back to whole-canvas behaviour for legacy entries with no bounds', () => {
    const fit = resolveOpaqueFit({ ...base, bounds: undefined });
    expect(fit).toEqual({ originX: 0.5, originY: 1, scale: 200 / 91 });
  });

  it('falls back when the bounds disagree with the loaded texture size', () => {
    // Art regenerated at a new canvas size without re-deriving bounds. Applying
    // stale bounds would mis-anchor silently; degrading to the old rendering is
    // wrong-but-recognisable, which is the safer failure.
    const fit = resolveOpaqueFit({
      ...base,
      bounds: BOOKCASE,
      canvasWidth: 64,
      canvasHeight: 64,
    });
    expect(fit).toEqual({ originX: 0.5, originY: 1, scale: 200 / 64 });
  });

  it('falls back when the bounds box overflows its own canvas', () => {
    const fit = resolveOpaqueFit({
      ...base,
      bounds: { ...BOOKCASE, x: 50, width: 86 },
    });
    expect(fit.originX).toBe(0.5);
    expect(fit.scale).toBeCloseTo(200 / 91, 6);
  });

  it('falls back when the bounds are degenerate', () => {
    const fit = resolveOpaqueFit({
      ...base,
      bounds: { ...BOOKCASE, width: 0, height: 0 },
    });
    expect(fit).toEqual({ originX: 0.5, originY: 1, scale: 200 / 91 });
  });

  it('never divides by zero on a texture that has not finished loading', () => {
    const fit = resolveOpaqueFit({
      ...base,
      bounds: BOOKCASE,
      canvasWidth: 0,
      canvasHeight: 0,
    });
    expect(fit).toEqual({ originX: 0.5, originY: 1, scale: 1 });
  });

  it('is a no-op for art with no transparent margin', () => {
    const fit = resolveOpaqueFit({
      ...base,
      bounds: { x: 0, y: 0, width: 96, height: 91, canvasWidth: 96, canvasHeight: 91 },
    });
    expect(fit).toEqual({ originX: 0.5, originY: 1, scale: 200 / 91 });
  });
});
