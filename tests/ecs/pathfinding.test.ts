import { describe, expect, it } from 'vitest';
import { findTilePath, isTileTraversable, PATH_TRAVERSAL } from '../../src/core/map/pathfinding.js';
import { makePathMap } from '../helpers/map-fixtures.js';

describe('isTileTraversable', () => {
  it('returns false for out-of-bounds coordinates', () => {
    const floorMap = makePathMap(true);
    expect(isTileTraversable(floorMap, -1, 0, PATH_TRAVERSAL.GROUND)).toBe(false);
    expect(isTileTraversable(floorMap, 0, -1, PATH_TRAVERSAL.GROUND)).toBe(false);
    expect(isTileTraversable(floorMap, 9999, 9999, PATH_TRAVERSAL.GROUND)).toBe(false);
  });

  it('returns true for flying traversal on any in-bounds tile', () => {
    const floorMap = makePathMap(false);
    // Wall tile — not passable on ground but flying ignores terrain
    expect(isTileTraversable(floorMap, 5, 4, PATH_TRAVERSAL.FLYING)).toBe(true);
  });

  it('uses custom isTilePassable predicate when provided', () => {
    const floorMap = makePathMap(false);
    // Tile (5,4) is a wall but our predicate says everything is passable
    const alwaysPassable = () => true;
    expect(isTileTraversable(floorMap, 5, 4, PATH_TRAVERSAL.GROUND, alwaysPassable)).toBe(true);
  });
});

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

  it('returns [] when start is out-of-bounds', () => {
    const floorMap = makePathMap(true);
    expect(findTilePath(floorMap, { x: -1, y: 0 }, { x: 2, y: 4 })).toEqual([]);
  });

  it('returns [] when goal is out-of-bounds', () => {
    const floorMap = makePathMap(true);
    expect(findTilePath(floorMap, { x: 2, y: 4 }, { x: 9999, y: 9999 })).toEqual([]);
  });

  it('returns a single-element path when start equals goal', () => {
    const floorMap = makePathMap(true);
    const path = findTilePath(floorMap, { x: 2, y: 4 }, { x: 2, y: 4 });
    expect(path).toEqual([{ x: 2, y: 4 }]);
  });
});
