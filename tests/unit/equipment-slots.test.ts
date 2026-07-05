import { describe, expect, it } from 'vitest';
import { getSlotLabel } from '../../src/shared/equipment-slots.js';

describe('getSlotLabel', () => {
  it('returns the user-facing label for known slot ids', () => {
    expect(getSlotLabel('mainHand')).toBe('Main Hand');
    expect(getSlotLabel('offHand')).toBe('Off Hand');
  });

  it('falls back to the raw slot id for unknown values', () => {
    expect(getSlotLabel('mystery-slot')).toBe('mystery-slot');
  });
});
