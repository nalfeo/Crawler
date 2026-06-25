import { describe, expect, it } from 'vitest';
import { resolveCrit, resolveDodge } from '../../src/core/combat-rolls.js';

describe('resolveCrit', () => {
  it('crits when the roll is below critChance and scales by the multiplier', () => {
    const result = resolveCrit(0.04, 10, 0.05, 1.5);
    expect(result.isCrit).toBe(true);
    expect(result.amount).toBe(15);
  });

  it('does not crit when the roll is at or above critChance', () => {
    const result = resolveCrit(0.05, 10, 0.05, 1.5);
    expect(result.isCrit).toBe(false);
    expect(result.amount).toBe(10);
  });

  it('never crits when critChance is zero', () => {
    const result = resolveCrit(0, 10, 0, 1.5);
    expect(result.isCrit).toBe(false);
    expect(result.amount).toBe(10);
  });

  it('treats a non-positive multiplier as 1x (no damage loss on a crit)', () => {
    const result = resolveCrit(0, 10, 1, 0);
    expect(result.isCrit).toBe(true);
    expect(result.amount).toBe(10);
  });

  it('always crits when critChance is 1 (roll is in [0, 1))', () => {
    expect(resolveCrit(0.999, 8, 1, 2).isCrit).toBe(true);
    expect(resolveCrit(0.999, 8, 1, 2).amount).toBe(16);
  });
});

describe('resolveDodge', () => {
  it('dodges when the roll is below dodgeChance', () => {
    expect(resolveDodge(0.2, 0.25)).toBe(true);
  });

  it('does not dodge when the roll is at or above dodgeChance', () => {
    expect(resolveDodge(0.25, 0.25)).toBe(false);
    expect(resolveDodge(0.9, 0.25)).toBe(false);
  });

  it('never dodges when dodgeChance is zero', () => {
    expect(resolveDodge(0, 0)).toBe(false);
  });
});
