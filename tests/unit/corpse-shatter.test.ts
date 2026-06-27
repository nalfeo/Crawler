import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAUNCH_PARAMS,
  SHATTER_COLS,
  SHATTER_GRAVITY,
  SHATTER_ROWS,
  buildShatterSpecs,
  integratePieceVelocity,
  pieceProgress,
  rollPieceLaunch,
  scaleLaunchParams,
  shatterAlpha,
  shatterScale,
  type ShatterPieceSpec,
} from '../../src/engine/corpse-shatter.js';

/** Deterministic rng stub: always returns the midpoint (no jitter). */
const midRng = (): number => 0.5;

describe('buildShatterSpecs', () => {
  it('produces cols*rows specs in row-major order', () => {
    const specs = buildShatterSpecs(16, 16, 3, 3);
    expect(specs).toHaveLength(9);
    expect(specs[0]).toMatchObject({ col: 0, row: 0 });
    expect(specs[8]).toMatchObject({ col: 2, row: 2 });
  });

  it('defaults to the SHATTER_COLS x SHATTER_ROWS grid', () => {
    const specs = buildShatterSpecs(20, 20);
    expect(specs).toHaveLength(SHATTER_COLS * SHATTER_ROWS);
  });

  it('tiles the frame exactly: crop areas sum to the whole frame with integer bounds', () => {
    const frameW = 16;
    const frameH = 16;
    const specs = buildShatterSpecs(frameW, frameH, 3, 3);

    let area = 0;
    for (const s of specs) {
      expect(Number.isInteger(s.cropX)).toBe(true);
      expect(Number.isInteger(s.cropY)).toBe(true);
      expect(s.cropW).toBeGreaterThan(0);
      expect(s.cropH).toBeGreaterThan(0);
      expect(s.cropX + s.cropW).toBeLessThanOrEqual(frameW);
      expect(s.cropY + s.cropH).toBeLessThanOrEqual(frameH);
      area += s.cropW * s.cropH;
    }
    expect(area).toBe(frameW * frameH);
  });

  it('adjacent columns and rows share edges (no gaps or overlaps)', () => {
    const specs = buildShatterSpecs(16, 16, 3, 3);
    const at = (col: number, row: number): ShatterPieceSpec =>
      specs.find((s) => s.col === col && s.row === row)!;

    // Right edge of (0,0) meets left edge of (1,0).
    expect(at(0, 0).cropX + at(0, 0).cropW).toBe(at(1, 0).cropX);
    // Bottom edge of (0,0) meets top edge of (0,1).
    expect(at(0, 0).cropY + at(0, 0).cropH).toBe(at(0, 1).cropY);
  });

  it('places the transform origin at each cell centre as a fraction of the frame', () => {
    const specs = buildShatterSpecs(16, 16, 3, 3);
    for (const s of specs) {
      expect(s.originX).toBeGreaterThanOrEqual(0);
      expect(s.originX).toBeLessThanOrEqual(1);
      expect(s.originY).toBeGreaterThanOrEqual(0);
      expect(s.originY).toBeLessThanOrEqual(1);
    }
  });

  it('points each cell outward from the sprite centre; the centre cell has no direction', () => {
    const specs = buildShatterSpecs(15, 15, 3, 3);
    const at = (col: number, row: number): ShatterPieceSpec =>
      specs.find((s) => s.col === col && s.row === row)!;

    // Top-left cell sprays up-and-left.
    expect(at(0, 0).dirX).toBeLessThan(0);
    expect(at(0, 0).dirY).toBeLessThan(0);
    // Bottom-right cell sprays down-and-right.
    expect(at(2, 2).dirX).toBeGreaterThan(0);
    expect(at(2, 2).dirY).toBeGreaterThan(0);
    // Dead-centre cell has (near) zero outward direction.
    expect(Math.hypot(at(1, 1).dirX, at(1, 1).dirY)).toBeCloseTo(0);
  });

  it('outward directions are unit length (except the centre cell)', () => {
    const specs = buildShatterSpecs(16, 16, 3, 3);
    for (const s of specs) {
      const mag = Math.hypot(s.dirX, s.dirY);
      expect(mag === 0 || Math.abs(mag - 1) < 1e-6).toBe(true);
    }
  });

  it('tiles any positive frame size exactly (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 256 }),
        fc.integer({ min: 1, max: 256 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        (w, h, cols, rows) => {
          const specs = buildShatterSpecs(w, h, cols, rows);
          expect(specs).toHaveLength(cols * rows);
          let area = 0;
          for (const s of specs) area += s.cropW * s.cropH;
          expect(area).toBe(w * h);
        },
      ),
    );
  });

  it('never returns zero-area crops when the frame is at least the grid size (fast-check)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 64 }), fc.integer({ min: 3, max: 64 }), (w, h) => {
        for (const s of buildShatterSpecs(w, h, 3, 3)) {
          expect(s.cropW).toBeGreaterThan(0);
          expect(s.cropH).toBeGreaterThan(0);
        }
      }),
    );
  });
});

describe('scaleLaunchParams', () => {
  it('does not amplify launch at zero impact strength', () => {
    const p = scaleLaunchParams(DEFAULT_LAUNCH_PARAMS, 0, 0, 0);
    expect(p.baseSpeed).toBe(DEFAULT_LAUNCH_PARAMS.baseSpeed);
    expect(p.impactBoost).toBe(DEFAULT_LAUNCH_PARAMS.impactBoost);
  });

  it('doubles launch force at the saturation point and clamps beyond it', () => {
    const at40 = scaleLaunchParams(DEFAULT_LAUNCH_PARAMS, 40, 0, 0);
    const at400 = scaleLaunchParams(DEFAULT_LAUNCH_PARAMS, 400, 0, 0);
    expect(at40.baseSpeed).toBeCloseTo(DEFAULT_LAUNCH_PARAMS.baseSpeed * 2);
    expect(at400.baseSpeed).toBeCloseTo(at40.baseSpeed); // clamped, no runaway
  });

  it('threads the impact direction through', () => {
    const p = scaleLaunchParams(DEFAULT_LAUNCH_PARAMS, 10, 0.6, -0.8);
    expect(p.impactDirX).toBe(0.6);
    expect(p.impactDirY).toBe(-0.8);
  });
});

describe('rollPieceLaunch', () => {
  it('is deterministic for a fixed rng and launches along the cell direction', () => {
    const spec = buildShatterSpecs(16, 16, 3, 3).find((s) => s.col === 2 && s.row === 1)!;
    // spec dir points +x. With midRng there is no speed jitter and no spin.
    const launch = rollPieceLaunch(spec, DEFAULT_LAUNCH_PARAMS, midRng);
    expect(launch.vx).toBeCloseTo(spec.dirX * DEFAULT_LAUNCH_PARAMS.baseSpeed);
    expect(launch.vy).toBeCloseTo(spec.dirY * DEFAULT_LAUNCH_PARAMS.baseSpeed);
    expect(launch.rotVel).toBeCloseTo(0);
    expect(launch.lifetimeMs).toBeCloseTo(DEFAULT_LAUNCH_PARAMS.lifetimeMs);
  });

  it('biases launch along the impact direction via impactBoost', () => {
    // Top-centre cell: its outward dir is straight up (no x-component), so any
    // horizontal velocity must come purely from the +x impact boost.
    const spec = buildShatterSpecs(16, 16, 3, 3).find((s) => s.col === 1 && s.row === 0)!;
    expect(spec.dirX).toBeCloseTo(0);
    const params = scaleLaunchParams(DEFAULT_LAUNCH_PARAMS, 0, 1, 0);
    const launch = rollPieceLaunch(spec, params, midRng);
    expect(launch.vx).toBeCloseTo(DEFAULT_LAUNCH_PARAMS.impactBoost);
  });

  it('gives a dead-centre shard a non-zero velocity (random angle fallback)', () => {
    const spec = buildShatterSpecs(15, 15, 3, 3).find((s) => s.col === 1 && s.row === 1)!;
    const launch = rollPieceLaunch(spec, DEFAULT_LAUNCH_PARAMS, () => 0.25);
    expect(Math.hypot(launch.vx, launch.vy)).toBeGreaterThan(0);
  });

  it('keeps lifetime strictly positive for any rng output', () => {
    const spec = buildShatterSpecs(16, 16, 3, 3)[0]!;
    for (const r of [0, 0.001, 0.5, 0.999, 1]) {
      const launch = rollPieceLaunch(spec, DEFAULT_LAUNCH_PARAMS, () => r);
      expect(launch.lifetimeMs).toBeGreaterThan(0);
    }
  });
});

describe('pieceProgress', () => {
  it('is 0 at birth and 1 at end of life', () => {
    expect(pieceProgress(0, 600)).toBe(0);
    expect(pieceProgress(600, 600)).toBe(1);
  });

  it('clamps past end of life and treats non-positive lifetimes as finished', () => {
    expect(pieceProgress(900, 600)).toBe(1);
    expect(pieceProgress(50, 0)).toBe(1);
  });
});

describe('shatterAlpha', () => {
  it('holds full opacity through the first half of life, then fades to 0', () => {
    expect(shatterAlpha(0)).toBe(1);
    expect(shatterAlpha(0.5)).toBe(1);
    expect(shatterAlpha(1)).toBeCloseTo(0);
  });

  it('is monotonically non-increasing (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(shatterAlpha(lo)).toBeGreaterThanOrEqual(shatterAlpha(hi) - 1e-9);
        },
      ),
    );
  });
});

describe('shatterScale', () => {
  it('shrinks monotonically from 1 across the shard life', () => {
    expect(shatterScale(0)).toBe(1);
    expect(shatterScale(1)).toBeLessThan(1);
    expect(shatterScale(1)).toBeGreaterThan(0);
  });

  it('never grows (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(shatterScale(lo)).toBeGreaterThanOrEqual(shatterScale(hi) - 1e-9);
        },
      ),
    );
  });
});

describe('integratePieceVelocity', () => {
  it('is a no-op at zero dt', () => {
    const v = integratePieceVelocity(120, -30, 0);
    expect(v.vx).toBe(120);
    expect(v.vy).toBe(-30);
  });

  it('applies gravity to vy then linear drag to both axes', () => {
    const dt = 0.1;
    const retain = 1 - 0.6 * dt; // SHATTER_DRAG default is 0.6
    const v = integratePieceVelocity(100, 0, dt);
    expect(v.vx).toBeCloseTo(100 * retain); // drag bled some horizontal speed
    expect(v.vy).toBeCloseTo(SHATTER_GRAVITY * dt * retain);
  });

  it('clamps retain at 0 for very large dt (never reverses velocity)', () => {
    const v = integratePieceVelocity(100, 100, 100);
    expect(v.vx).toBe(0);
    expect(v.vy).toBe(0);
  });
});
