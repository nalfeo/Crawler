import { describe, expect, it } from 'vitest';
import {
  MINI_SLIME_SPAWN_ANIM_MS,
  computeSpawnPopScale,
  easeOutBack,
  spawnAnimProgress,
} from '../../src/shared/spawn-anim.js';

describe('spawnAnimProgress', () => {
  it('is 0 at spawn (remaining == total) and 1 when finished (remaining <= 0)', () => {
    expect(spawnAnimProgress(350, 350)).toBe(0);
    expect(spawnAnimProgress(0, 350)).toBe(1);
    expect(spawnAnimProgress(-50, 350)).toBe(1);
  });

  it('is 0.5 at the halfway point', () => {
    expect(spawnAnimProgress(175, 350)).toBeCloseTo(0.5, 6);
  });

  it('clamps to [0, 1] and treats a non-positive total as complete', () => {
    expect(spawnAnimProgress(500, 350)).toBe(0); // remaining > total
    expect(spawnAnimProgress(10, 0)).toBe(1);
    expect(spawnAnimProgress(10, -5)).toBe(1);
  });
});

describe('easeOutBack', () => {
  it('starts at 0 and settles at 1', () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 6);
    expect(easeOutBack(1)).toBeCloseTo(1, 6);
  });

  it('overshoots past 1 before settling (the "pop")', () => {
    // Somewhere in the back half the curve rises above 1.
    const peak = Math.max(easeOutBack(0.6), easeOutBack(0.7), easeOutBack(0.8));
    expect(peak).toBeGreaterThan(1);
  });

  it('clamps out-of-range progress', () => {
    expect(easeOutBack(-1)).toBeCloseTo(0, 6);
    expect(easeOutBack(2)).toBeCloseTo(1, 6);
  });
});

describe('computeSpawnPopScale', () => {
  it('is fully collapsed at p = 0 and full, steady size at p = 1', () => {
    const start = computeSpawnPopScale(0);
    expect(start.x).toBeCloseTo(0, 6);
    expect(start.y).toBeCloseTo(0, 6);

    const end = computeSpawnPopScale(1);
    expect(end.x).toBeCloseTo(1, 6);
    expect(end.y).toBeCloseTo(1, 6);
  });

  it('wiggles by squashing one axis while stretching the other mid-animation', () => {
    // Pick a progress where the decaying sine is clearly non-zero.
    const mid = computeSpawnPopScale(0.25, { wiggleAmplitude: 0.3, wiggleCycles: 3 });
    expect(mid.x).not.toBeCloseTo(mid.y, 3);
  });

  it('produces uniform scaling when wiggle amplitude is 0', () => {
    const mid = computeSpawnPopScale(0.4, { wiggleAmplitude: 0, wiggleCycles: 3 });
    expect(mid.x).toBeCloseTo(mid.y, 6);
  });

  it('keeps the wiggle settled (x == y) once the animation finishes', () => {
    const end = computeSpawnPopScale(1, { wiggleAmplitude: 0.5, wiggleCycles: 4 });
    expect(end.x).toBeCloseTo(end.y, 6);
  });
});

describe('MINI_SLIME_SPAWN_ANIM_MS', () => {
  it('is a short, positive, sub-second window', () => {
    expect(MINI_SLIME_SPAWN_ANIM_MS).toBeGreaterThan(0);
    expect(MINI_SLIME_SPAWN_ANIM_MS).toBeLessThan(1000);
  });
});
