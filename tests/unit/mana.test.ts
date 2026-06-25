import { describe, it, expect } from 'vitest';
import {
  MANA_BASE,
  MANA_PER_WISDOM,
  MANA_REGEN_PER_SECOND,
  MANA_REGEN_PER_FRAME,
  deriveMaxMp,
} from '../../src/shared/mana.js';
import { GAME } from '../../src/shared/constants.js';

describe('mana model (shared/mana.ts)', () => {
  it('maps effective Wisdom 1 to the historical 100 MP pool', () => {
    // Tuning anchor: a fresh player (effective Wisdom 1) keeps the old 100 MP.
    expect(deriveMaxMp(1)).toBe(100);
    expect(MANA_BASE + MANA_PER_WISDOM).toBe(100);
  });

  it('adds MANA_PER_WISDOM Max MP per effective Wisdom point', () => {
    expect(deriveMaxMp(2) - deriveMaxMp(1)).toBe(MANA_PER_WISDOM);
    expect(deriveMaxMp(10)).toBe(MANA_BASE + MANA_PER_WISDOM * 10);
  });

  it('floors non-finite / negative Wisdom at MANA_BASE', () => {
    expect(deriveMaxMp(0)).toBe(MANA_BASE);
    expect(deriveMaxMp(-5)).toBe(MANA_BASE);
    expect(deriveMaxMp(Number.NaN)).toBe(MANA_BASE);
    expect(deriveMaxMp(Number.POSITIVE_INFINITY)).toBe(MANA_BASE);
  });

  it('derives per-frame regen from the fixed timestep (deterministic, no Date.now)', () => {
    expect(MANA_REGEN_PER_FRAME).toBeCloseTo((MANA_REGEN_PER_SECOND * GAME.DELTA_MS) / 1000, 9);
    // Roughly one second of regen accrues over the target frame rate.
    expect(MANA_REGEN_PER_FRAME * GAME.TARGET_FPS).toBeCloseTo(MANA_REGEN_PER_SECOND, 6);
  });
});
