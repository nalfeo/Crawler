import { describe, expect, it } from 'vitest';
import { createSpatialHashGrid } from '../../src/core/collision.js';

describe('SpatialHashGrid', () => {
  it('finds overlapping entities via queryPairs', () => {
    const grid = createSpatialHashGrid();

    grid.insert(1, 10, 10, 8, 8);
    grid.insert(2, 16, 10, 8, 8);

    expect(grid.queryPairs()).toEqual([{ a: 1, b: 2 }]);
  });

  it('returns no pairs for non-overlapping entities', () => {
    const grid = createSpatialHashGrid();

    grid.insert(1, 0, 0, 8, 8);
    grid.insert(2, 100, 100, 8, 8);

    expect(grid.queryPairs()).toEqual([]);
  });

  it('returns nearby entities for radius queries', () => {
    const grid = createSpatialHashGrid();

    grid.insert(1, 0, 0, 4, 4);
    grid.insert(2, 40, 0, 4, 4);
    grid.insert(3, 120, 0, 4, 4);

    const nearby = [...grid.queryRadius(0, 0, 50)].sort((a, b) => a - b);

    expect(nearby).toEqual([1, 2]);
  });

  it('deduplicates pairs and keeps them ordered by entity id', () => {
    const grid = createSpatialHashGrid();

    grid.insert(9, 64, 64, 40, 40);
    grid.insert(3, 80, 80, 24, 24);

    expect(grid.queryPairs()).toEqual([{ a: 3, b: 9 }]);
  });

  it('handles 500 entities within the performance budget', () => {
    const grid = createSpatialHashGrid();
    const start = performance.now();

    for (let index = 0; index < 500; index += 1) {
      grid.insert(index, (index % 25) * 48, Math.floor(index / 25) * 48, 6, 6);
    }

    const pairs = grid.queryPairs();
    const durationMs = performance.now() - start;

    expect(pairs).toEqual([]);
    expect(durationMs).toBeLessThan(50);
  });

  it('handles same-position entities and grid-boundary overlaps', () => {
    const grid = createSpatialHashGrid();

    grid.insert(1, 0, 0, 4, 4);
    grid.insert(2, 0, 0, 4, 4);
    grid.insert(3, 63, 16, 2, 2);
    grid.insert(4, 65, 16, 2, 2);

    expect(grid.queryPairs()).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });
});
