import { describe, expect, it } from 'vitest';
import { findTilePath, PATH_TRAVERSAL } from '../../src/core/map/pathfinding.js';
import { makePathMap } from '../helpers/map-fixtures.js';

describe('findTilePath', () => {
  it('routes through an open door instead of crossing blocked pillar walls', () => {
    const floorMap = makePathMap(true);
    const path = findTilePath(floorMap, { x: 2, y: 4 }, { x: 9, y: 4 });

    expect(path.length).toBeGreaterThan(0);
    expect(path.some((point) => point.x === 6 && point.y === 4)).toBe(true);
  });

  it('returns no ground path when the only door is closed', () => {
    const floorMap = makePathMap(false);
    const path = findTilePath(floorMap, { x: 2, y: 4 }, { x: 9, y: 4 });

    expect(path).toEqual([]);
  });

  it('allows flying traversal when ground path is blocked by closed structures', () => {
    const floorMap = makePathMap(false);
    const path = findTilePath(
      floorMap,
      { x: 2, y: 4 },
      { x: 9, y: 4 },
      { traversalMode: PATH_TRAVERSAL.FLYING },
    );

    expect(path.length).toBeGreaterThan(0);
    expect(path[0]).toEqual({ x: 2, y: 4 });
    expect(path[path.length - 1]).toEqual({ x: 9, y: 4 });
  });
});
