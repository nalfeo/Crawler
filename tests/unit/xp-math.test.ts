import { describe, it, expect } from 'vitest';
import { xpThresholdForLevel, xpRequiredForLevel, levelForXp } from '../../src/shared/xpMath.js';

describe('xpThresholdForLevel', () => {
  it('level 0 equals BASE_PER_LEVEL (10)', () => {
    expect(xpThresholdForLevel(0)).toBe(10);
  });

  it('returns floor of 10 * 1.15^n', () => {
    expect(xpThresholdForLevel(1)).toBe(Math.floor(10 * 1.15));
    expect(xpThresholdForLevel(2)).toBe(Math.floor(10 * 1.15 ** 2));
    expect(xpThresholdForLevel(5)).toBe(Math.floor(10 * 1.15 ** 5));
  });

  it('strictly increases', () => {
    for (let i = 0; i < 20; i++) {
      expect(xpThresholdForLevel(i + 1)).toBeGreaterThan(xpThresholdForLevel(i));
    }
  });
});

describe('xpRequiredForLevel', () => {
  it('level 0 requires 0 XP', () => {
    expect(xpRequiredForLevel(0)).toBe(0);
  });

  it('level 1 requires threshold(0) XP', () => {
    expect(xpRequiredForLevel(1)).toBe(xpThresholdForLevel(0));
  });

  it('level 2 is cumulative sum of thresholds 0 and 1', () => {
    expect(xpRequiredForLevel(2)).toBe(xpThresholdForLevel(0) + xpThresholdForLevel(1));
  });

  it('is strictly increasing', () => {
    for (let i = 0; i < 20; i++) {
      expect(xpRequiredForLevel(i + 1)).toBeGreaterThan(xpRequiredForLevel(i));
    }
  });
});

describe('levelForXp', () => {
  it('0 XP is level 0', () => {
    expect(levelForXp(0)).toBe(0);
  });

  it('exactly at threshold advances level', () => {
    const threshold = xpRequiredForLevel(1);
    expect(levelForXp(threshold)).toBe(1);
  });

  it('one less than threshold stays at previous level', () => {
    const threshold = xpRequiredForLevel(1);
    expect(levelForXp(threshold - 1)).toBe(0);
  });

  it('is consistent with xpRequiredForLevel up to level 30', () => {
    for (let level = 0; level <= 30; level++) {
      const xp = xpRequiredForLevel(level);
      expect(levelForXp(xp)).toBe(level);
    }
  });
});
