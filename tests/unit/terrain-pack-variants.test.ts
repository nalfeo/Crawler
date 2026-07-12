/**
 * Tests for deterministic terrain-pack variant selection
 * (`src/shared/terrain-pack-variants.ts`) — pool variant picking and the
 * pure door-state resolver (reviewed-design refinements #3, #5).
 */
import { describe, expect, it } from 'vitest';
import {
  deriveTileVariantSeed,
  pickPoolVariant,
  resolveDoorOrientationFromFlanks,
  resolveDoorPoolVariant,
} from '../../src/shared/terrain-pack-variants.js';
import type { DoorSetDef, PoolVariantDef } from '../../src/shared/terrain-pack-types.js';

function pool(count: number): PoolVariantDef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `variant-${i}`,
    imagePath: `assets/variant-${i}.png`,
    textureKey: `variant-${i}`,
  }));
}

const doorSet: DoorSetDef = {
  openHorizontal: { imagePath: 'oh.png', textureKey: 'open-horizontal' },
  openVertical: { imagePath: 'ov.png', textureKey: 'open-vertical' },
  closedHorizontal: { imagePath: 'ch.png', textureKey: 'closed-horizontal' },
  closedVertical: { imagePath: 'cv.png', textureKey: 'closed-vertical' },
};

describe('deriveTileVariantSeed', () => {
  it('is a pure function of (floorSeed, tx, ty): same inputs -> same output', () => {
    expect(deriveTileVariantSeed(42, 3, 5)).toBe(deriveTileVariantSeed(42, 3, 5));
  });

  it('varies with tile coordinates for a fixed floor seed', () => {
    const a = deriveTileVariantSeed(42, 3, 5);
    const b = deriveTileVariantSeed(42, 3, 6);
    const c = deriveTileVariantSeed(42, 4, 5);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('varies with the floor seed for a fixed coordinate', () => {
    expect(deriveTileVariantSeed(1, 0, 0)).not.toBe(deriveTileVariantSeed(2, 0, 0));
  });

  it('never returns a value outside the signed 32-bit range', () => {
    for (let i = 0; i < 200; i++) {
      const value = deriveTileVariantSeed(i * 7919, i, i * 3);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(value).toBeLessThan(2 ** 31);
    }
  });
});

describe('pickPoolVariant', () => {
  it('returns null for an empty pool (caller falls back to legacy rendering)', () => {
    expect(pickPoolVariant([], 42, 0, 0)).toBeNull();
  });

  it('returns the sole variant for a single-entry pool regardless of coordinates', () => {
    const single = pool(1);
    expect(pickPoolVariant(single, 42, 0, 0)).toBe(single[0]);
    expect(pickPoolVariant(single, 999, 17, 4)).toBe(single[0]);
  });

  it('is deterministic: the same (pool, seed, x, y) always yields the same variant', () => {
    const p = pool(5);
    const first = pickPoolVariant(p, 42, 10, 20);
    const second = pickPoolVariant(p, 42, 10, 20);
    expect(first).toBe(second);
  });

  it('produces different variants across a spread of coordinates (not constant)', () => {
    const p = pool(5);
    const results = new Set<string>();
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 20; y++) {
        const v = pickPoolVariant(p, 42, x, y);
        if (v) results.add(v.id);
      }
    }
    // With 400 samples across 5 variants we expect meaningfully more than 1
    // distinct id to appear — proves it isn't degenerately constant.
    expect(results.size).toBeGreaterThan(1);
  });

  it('always returns a member of the supplied pool', () => {
    const p = pool(4);
    const ids = new Set(p.map((v) => v.id));
    for (let x = 0; x < 10; x++) {
      const variant = pickPoolVariant(p, 7, x, x * 2);
      expect(variant).not.toBeNull();
      expect(ids.has(variant!.id)).toBe(true);
    }
  });
});

describe('resolveDoorPoolVariant — pure open/closed x horizontal/vertical resolver', () => {
  it('resolves all 4 combinations to their matching doorSet entry', () => {
    expect(resolveDoorPoolVariant(doorSet, { isOpen: true, orientation: 'horizontal' })).toBe(
      doorSet.openHorizontal,
    );
    expect(resolveDoorPoolVariant(doorSet, { isOpen: true, orientation: 'vertical' })).toBe(
      doorSet.openVertical,
    );
    expect(resolveDoorPoolVariant(doorSet, { isOpen: false, orientation: 'horizontal' })).toBe(
      doorSet.closedHorizontal,
    );
    expect(resolveDoorPoolVariant(doorSet, { isOpen: false, orientation: 'vertical' })).toBe(
      doorSet.closedVertical,
    );
  });

  it('is a pure function: repeated calls with the same key return the same reference', () => {
    const key = { isOpen: false, orientation: 'vertical' } as const;
    expect(resolveDoorPoolVariant(doorSet, key)).toBe(resolveDoorPoolVariant(doorSet, key));
  });
});

describe('resolveDoorOrientationFromFlanks — door axis semantics (Fix 2)', () => {
  it('horizontalDoorway=true (walls left+right) → vertical art (passage runs top-to-bottom)', () => {
    expect(resolveDoorOrientationFromFlanks(true)).toBe('vertical');
  });

  it('horizontalDoorway=false (walls top+bottom) → horizontal art (passage runs left-to-right)', () => {
    expect(resolveDoorOrientationFromFlanks(false)).toBe('horizontal');
  });

  it('is a pure function: same input always returns the same string', () => {
    expect(resolveDoorOrientationFromFlanks(true)).toBe(resolveDoorOrientationFromFlanks(true));
    expect(resolveDoorOrientationFromFlanks(false)).toBe(resolveDoorOrientationFromFlanks(false));
  });
});
