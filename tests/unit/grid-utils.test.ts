import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ORTHO_NEIGHBORS,
  coordsToIndex,
  floodFill,
  indexToCoords,
  indexToX,
  indexToY,
} from '../../src/core/map/grid-utils.js';

describe('grid-utils coordinate conversion', () => {
  it('round-trips coords <-> index', () => {
    const width = 7;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 20 }), (x, y) => {
        const idx = coordsToIndex(x, y, width);
        expect(indexToX(idx, width)).toBe(x);
        expect(indexToY(idx, width)).toBe(y);
        expect(indexToCoords(idx, width)).toEqual([x, y]);
      }),
    );
  });

  it('matches manual row-major math', () => {
    expect(coordsToIndex(3, 2, 5)).toBe(13);
    expect(indexToCoords(13, 5)).toEqual([3, 2]);
  });
});

describe('grid-utils ORTHO_NEIGHBORS', () => {
  it('is the 4 cardinal offsets', () => {
    expect(ORTHO_NEIGHBORS).toEqual([
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]);
  });
});

describe('grid-utils floodFill', () => {
  it('fills a fully passable grid', () => {
    const w = 4;
    const h = 4;
    const visited = floodFill(0, w, h, () => true);
    expect([...visited].every((v) => v === 1)).toBe(true);
  });

  it('does not cross walls and reports unreachable cells', () => {
    const w = 3;
    const h = 1;
    // [open][wall][open] — fill from 0 cannot reach index 2
    const passable = (idx: number) => idx !== 1;
    const visited = floodFill(0, w, h, passable);
    expect(visited[0]).toBe(1);
    expect(visited[1]).toBe(0);
    expect(visited[2]).toBe(0);
  });

  it('invokes onVisit exactly once per reachable cell', () => {
    const w = 3;
    const h = 3;
    const order: number[] = [];
    floodFill(
      4,
      w,
      h,
      () => true,
      (idx) => order.push(idx),
    );
    expect(order.length).toBe(9);
    expect(new Set(order).size).toBe(9);
  });

  it('returns empty mask when start is blocked', () => {
    const visited = floodFill(0, 2, 2, () => false);
    expect([...visited].every((v) => v === 0)).toBe(true);
  });
});
