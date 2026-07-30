import { describe, expect, it } from 'vitest';
import {
  MIRROR_SLOT_IDS,
  MIRROR_SLOT_PAIRS,
  VALID_SLOT_IDS,
  getMirrorSlot,
  getSlotLabel,
} from '../../src/shared/equipment-slots.js';

describe('getSlotLabel', () => {
  it('returns the user-facing label for known slot ids', () => {
    expect(getSlotLabel('mainHand')).toBe('Main Hand');
    expect(getSlotLabel('offHand')).toBe('Off Hand');
  });

  it('falls back to the raw slot id for unknown values', () => {
    expect(getSlotLabel('mystery-slot')).toBe('mystery-slot');
  });
});

describe('mirror slot metadata', () => {
  it('every mirror-pair id is a real registry slot', () => {
    for (const [a, b] of MIRROR_SLOT_PAIRS) {
      expect(VALID_SLOT_IDS.has(a)).toBe(true);
      expect(VALID_SLOT_IDS.has(b)).toBe(true);
    }
  });

  it('pairs are disjoint — no slot appears in two pairs', () => {
    const seen = new Set<string>();
    for (const [a, b] of MIRROR_SLOT_PAIRS) {
      for (const id of [a, b]) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen).toEqual(new Set(MIRROR_SLOT_IDS));
  });

  it('getMirrorSlot is symmetric for paired slots', () => {
    for (const [a, b] of MIRROR_SLOT_PAIRS) {
      expect(getMirrorSlot(a)).toBe(b);
      expect(getMirrorSlot(b)).toBe(a);
    }
  });

  it('getMirrorSlot returns undefined for non-mirror and unknown slots', () => {
    expect(getMirrorSlot('mainHand')).toBeUndefined();
    expect(getMirrorSlot('offHand')).toBeUndefined();
    expect(getMirrorSlot('head')).toBeUndefined();
    expect(getMirrorSlot('gloves')).toBeUndefined();
    expect(getMirrorSlot('mystery-slot')).toBeUndefined();
  });

  it('MIRROR_SLOT_IDS contains exactly the paired slot ids', () => {
    expect(MIRROR_SLOT_IDS.size).toBe(MIRROR_SLOT_PAIRS.length * 2);
  });
});
