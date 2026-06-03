import { describe, expect, it } from 'vitest';
import { FLOOR, GAME, XP } from '../../src/shared/constants.js';

describe('game constants', () => {
  it('uses a target framerate of 60 FPS', () => {
    expect(GAME.TARGET_FPS).toBe(60);
  });

  it('uses a frame delta close to 1000 / 60 milliseconds', () => {
    expect(GAME.DELTA_MS).toBeCloseTo(1000 / 60, 10);
  });

  it('keeps all floor durations positive', () => {
    for (const value of Object.values(FLOOR)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it('uses an XP scaling factor above 1', () => {
    expect(XP.SCALING_FACTOR).toBeGreaterThan(1);
  });
});
