import { describe, expect, it } from 'vitest';
import {
  SLOT_REGISTRY,
  _getMirrorSlotForTests,
  _MIRROR_SLOT_IDS_FOR_TESTS,
  _MIRROR_SLOT_PAIRS_FOR_TESTS,
  _VALID_SLOT_IDS_FOR_TESTS,
  getSlotLabel,
} from '../../src/shared/equipment-slots.js';

describe('active equipment slot contract', () => {
  it('contains exactly the ten persisted gameplay slots', () => {
    expect(SLOT_REGISTRY.map((slot) => slot.id)).toEqual([
      'head',
      'neck',
      'mainHand',
      'chest',
      'offHand',
      'gloves',
      'legs',
      'ring1',
      'feet',
      'ring2',
    ]);
    for (const retired of [
      'face',
      'leftArm',
      'rightArm',
      'shoulders',
      'leftWrist',
      'rightWrist',
      'back',
      'belt',
      'ringLeft',
      'ringRight',
    ]) {
      expect(_VALID_SLOT_IDS_FOR_TESTS.has(retired)).toBe(false);
    }
  });
});

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
    for (const [a, b] of _MIRROR_SLOT_PAIRS_FOR_TESTS) {
      expect(_VALID_SLOT_IDS_FOR_TESTS.has(a)).toBe(true);
      expect(_VALID_SLOT_IDS_FOR_TESTS.has(b)).toBe(true);
    }
  });

  it('pairs are disjoint — no slot appears in two pairs', () => {
    const seen = new Set<string>();
    for (const [a, b] of _MIRROR_SLOT_PAIRS_FOR_TESTS) {
      for (const id of [a, b]) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen).toEqual(new Set(_MIRROR_SLOT_IDS_FOR_TESTS));
  });

  it('getMirrorSlot is symmetric for paired slots', () => {
    for (const [a, b] of _MIRROR_SLOT_PAIRS_FOR_TESTS) {
      expect(_getMirrorSlotForTests(a)).toBe(b);
      expect(_getMirrorSlotForTests(b)).toBe(a);
    }
  });

  it('getMirrorSlot returns undefined for non-mirror and unknown slots', () => {
    expect(_getMirrorSlotForTests('mainHand')).toBeUndefined();
    expect(_getMirrorSlotForTests('offHand')).toBeUndefined();
    expect(_getMirrorSlotForTests('head')).toBeUndefined();
    expect(_getMirrorSlotForTests('gloves')).toBeUndefined();
    expect(_getMirrorSlotForTests('mystery-slot')).toBeUndefined();
  });

  it('MIRROR_SLOT_IDS contains exactly the paired slot ids', () => {
    expect(_MIRROR_SLOT_IDS_FOR_TESTS.size).toBe(_MIRROR_SLOT_PAIRS_FOR_TESTS.length * 2);
  });
});
