import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { VEC_EPSILON, distance, distanceSq, length, normalize } from '../../src/shared/vec.js';

describe('vec.length', () => {
  it('returns euclidean magnitude', () => {
    expect(length(3, 4)).toBe(5);
    expect(length(0, 0)).toBe(0);
  });
});

describe('vec.distance', () => {
  it('returns distance between points', () => {
    expect(distance(0, 0, 3, 4)).toBe(5);
    expect(distance(1, 1, 1, 1)).toBe(0);
  });

  it('is symmetric', () => {
    expect(distance(2, 3, 7, 9)).toBeCloseTo(distance(7, 9, 2, 3));
  });
});

describe('vec.distanceSq', () => {
  it('equals distance squared', () => {
    expect(distanceSq(0, 0, 3, 4)).toBe(25);
  });

  it('matches distance() squared for random points', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (ax, ay, bx, by) => {
          expect(distanceSq(ax, ay, bx, by)).toBeCloseTo(distance(ax, ay, bx, by) ** 2, 5);
        },
      ),
    );
  });
});

describe('vec.normalize', () => {
  it('produces a unit vector for non-zero input', () => {
    const n = normalize(3, 4);
    expect(n.x).toBeCloseTo(0.6);
    expect(n.y).toBeCloseTo(0.8);
    expect(n.length).toBe(5);
  });

  it('returns default fallback (0,0) for zero-length input', () => {
    expect(normalize(0, 0)).toEqual({ x: 0, y: 0, length: 0 });
    expect(normalize(VEC_EPSILON / 2, 0)).toEqual({ x: 0, y: 0, length: 0 });
  });

  it('returns supplied fallback for zero-length input', () => {
    expect(normalize(0, 0, 1, 0)).toEqual({ x: 1, y: 0, length: 0 });
  });

  it('always yields unit magnitude for non-degenerate vectors', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (x, y) => {
          fc.pre(Math.hypot(x, y) > VEC_EPSILON);
          const n = normalize(x, y);
          expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 5);
        },
      ),
    );
  });
});
