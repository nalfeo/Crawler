import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  extrapolateRenderPosition,
  renderInterpolationAlpha,
} from '../../src/engine/scenes/main-game-scene-helpers.js';
import { GAME } from '../../src/shared/constants.js';

/**
 * Regression guard for smooth rendering (issue #2945, "the game feels laggy and
 * not smooth when playing").
 *
 * The scene simulates on a fixed 60Hz accumulator but renders on rAF, so the
 * shipped game used to draw every frame at the last completed step
 * (`bridge.sync(world)` → `interpAlpha = 0`) while the labs already passed an
 * interpolation factor. Rendered frames therefore advanced the world by zero
 * steps or two, which reads as judder.
 */
describe('render interpolation alpha', () => {
  it('is zero at a step boundary and approaches one just before the next step', () => {
    expect(renderInterpolationAlpha(0, GAME.DELTA_MS)).toBe(0);
    expect(renderInterpolationAlpha(GAME.DELTA_MS / 2, GAME.DELTA_MS)).toBeCloseTo(0.5, 10);
    expect(renderInterpolationAlpha(GAME.DELTA_MS, GAME.DELTA_MS)).toBe(1);
  });

  it('clamps a negative accumulator to zero (paused single-step drain)', () => {
    // The paused advance-frame path zeroes the accumulator mid-step and then
    // subtracts one step, leaving it at -DELTA_MS. Rendering at a negative alpha
    // would rewind sprites and push renderElapsedMs into the past.
    expect(renderInterpolationAlpha(-GAME.DELTA_MS, GAME.DELTA_MS)).toBe(0);
  });

  it('clamps an over-full accumulator to one step', () => {
    expect(renderInterpolationAlpha(GAME.DELTA_MS * 4, GAME.DELTA_MS)).toBe(1);
  });

  it('returns zero for non-finite or non-positive inputs', () => {
    expect(renderInterpolationAlpha(Number.NaN, GAME.DELTA_MS)).toBe(0);
    expect(renderInterpolationAlpha(Number.POSITIVE_INFINITY, GAME.DELTA_MS)).toBe(0);
    expect(renderInterpolationAlpha(5, 0)).toBe(0);
    expect(renderInterpolationAlpha(5, Number.NaN)).toBe(0);
  });

  it('always yields a factor within [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: 0.001, max: 1000, noNaN: true }),
        (accumulatorMs, stepMs) => {
          const alpha = renderInterpolationAlpha(accumulatorMs, stepMs);
          expect(alpha).toBeGreaterThanOrEqual(0);
          expect(alpha).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe('extrapolateRenderPosition', () => {
  it('matches the bridge expression `position + velocity * alpha`', () => {
    expect(extrapolateRenderPosition(10, 0.375, 0)).toBe(10);
    expect(extrapolateRenderPosition(10, 0.375, 1)).toBeCloseTo(10.375, 10);
    expect(extrapolateRenderPosition(10, 0.375, 0.5)).toBeCloseTo(10.1875, 10);
  });

  it('never advances further than a single simulation step', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (position, velocity, alpha) => {
          const rendered = extrapolateRenderPosition(position, velocity, alpha);
          expect(Math.abs(rendered - position)).toBeLessThanOrEqual(Math.abs(velocity) + 1e-9);
        },
      ),
    );
  });
});

describe('MainGameScene render interpolation wiring', () => {
  const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

  it('feeds the accumulator fraction into the live gameplay bridge sync', () => {
    expect(source).toContain(
      'this.renderInterpAlpha = renderInterpolationAlpha(this.accumulator, GAME.DELTA_MS);',
    );
    expect(source).toContain(
      'this.world.elapsedMs + this.renderInterpAlpha * GAME.DELTA_MS,\n      this.renderInterpAlpha,\n    );',
    );
  });

  it('resets the factor to zero so frozen frames render the last completed step', () => {
    expect(source).toContain('this.renderInterpAlpha = 0;');
    const resetIndex = source.indexOf('this.renderInterpAlpha = 0;');
    const updateIndex = source.indexOf('update(_time: number, delta: number): void {');
    const stepLoopIndex = source.indexOf(
      'while (this.accumulator >= GAME.DELTA_MS && steps < maxStepsThisFrame)',
    );
    expect(updateIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeGreaterThan(updateIndex);
    expect(resetIndex).toBeLessThan(stepLoopIndex);
  });

  it('follows the camera on the same extrapolated player position as the sprites', () => {
    expect(source).toContain(
      'ftToPx(extrapolateRenderPosition(this.playerRenderCurrX, stepDx, alpha))',
    );
    expect(source).toContain(
      'ftToPx(extrapolateRenderPosition(this.playerRenderCurrY, stepDy, alpha))',
    );
  });
});
