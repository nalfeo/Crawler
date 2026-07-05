import { describe, expect, it } from 'vitest';
import {
  computeMobLevelScale,
  MOB_SCALING_HP_MULT_MAX,
  MOB_SCALING_HP_MULT_MIN,
  MOB_SCALING_REFERENCE_DIST_FT,
  MOB_SCALING_SPEED_MULT_MAX,
} from '../../src/shared/mob-scaling.js';

describe('computeMobLevelScale', () => {
  it('returns minimum multipliers at distance 0', () => {
    const scale = computeMobLevelScale(0);
    expect(scale.hpMult).toBe(MOB_SCALING_HP_MULT_MIN);
    expect(scale.speedMult).toBe(1.0);
  });

  it('returns maximum multipliers at the reference distance', () => {
    const scale = computeMobLevelScale(MOB_SCALING_REFERENCE_DIST_FT);
    expect(scale.hpMult).toBeCloseTo(MOB_SCALING_HP_MULT_MAX, 5);
    expect(scale.speedMult).toBeCloseTo(MOB_SCALING_SPEED_MULT_MAX, 5);
  });

  it('clamps to minimum for negative distances', () => {
    const scale = computeMobLevelScale(-50);
    expect(scale.hpMult).toBe(MOB_SCALING_HP_MULT_MIN);
    expect(scale.speedMult).toBe(1.0);
  });

  it('clamps to maximum for distances beyond the reference', () => {
    const scale = computeMobLevelScale(MOB_SCALING_REFERENCE_DIST_FT * 10);
    expect(scale.hpMult).toBeCloseTo(MOB_SCALING_HP_MULT_MAX, 5);
    expect(scale.speedMult).toBeCloseTo(MOB_SCALING_SPEED_MULT_MAX, 5);
  });

  it('returns midpoint values at half the reference distance', () => {
    const scale = computeMobLevelScale(MOB_SCALING_REFERENCE_DIST_FT / 2);
    const expectedHp =
      MOB_SCALING_HP_MULT_MIN + (MOB_SCALING_HP_MULT_MAX - MOB_SCALING_HP_MULT_MIN) / 2;
    const expectedSpeed = 1.0 + (MOB_SCALING_SPEED_MULT_MAX - 1.0) / 2;
    expect(scale.hpMult).toBeCloseTo(expectedHp, 5);
    expect(scale.speedMult).toBeCloseTo(expectedSpeed, 5);
  });

  it('is monotonically non-decreasing', () => {
    const distances = [0, 50, 100, 125, 175, 200, 250, 500];
    let prevHp = -Infinity;
    let prevSpeed = -Infinity;
    for (const d of distances) {
      const scale = computeMobLevelScale(d);
      expect(scale.hpMult).toBeGreaterThanOrEqual(prevHp);
      expect(scale.speedMult).toBeGreaterThanOrEqual(prevSpeed);
      prevHp = scale.hpMult;
      prevSpeed = scale.speedMult;
    }
  });

  it('never exceeds defined maximums', () => {
    for (const d of [0, 50, 150, 250, 1000]) {
      const scale = computeMobLevelScale(d);
      expect(scale.hpMult).toBeLessThanOrEqual(MOB_SCALING_HP_MULT_MAX);
      expect(scale.speedMult).toBeLessThanOrEqual(MOB_SCALING_SPEED_MULT_MAX);
    }
  });

  it('multipliers are always at least 1.0', () => {
    for (const d of [-100, 0, 100, 250]) {
      const scale = computeMobLevelScale(d);
      expect(scale.hpMult).toBeGreaterThanOrEqual(1.0);
      expect(scale.speedMult).toBeGreaterThanOrEqual(1.0);
    }
  });

  // Regression guard: these endpoints are CALIBRATED against the headless
  // Floor-1 AI-time budget, not free design knobs. A steeper 1.5×/1.1× ramp
  // pushed one winning sword+arena seed's clear time to 379s, past the 360s
  // budget in `tests/headless/spawner-arena-win-rate.test.ts`, because deeper
  // mobs take proportionally longer to kill. If you change these values,
  // RE-RUN `npm run test:headless` — the ramp must stay under the AI budget.
  it('keeps the calibrated endpoints under the headless AI-time budget', () => {
    expect(MOB_SCALING_HP_MULT_MAX).toBe(1.25);
    expect(MOB_SCALING_SPEED_MULT_MAX).toBe(1.05);
    expect(MOB_SCALING_REFERENCE_DIST_FT).toBe(250);
  });
});
