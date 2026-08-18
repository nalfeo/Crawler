/**
 * Differential equivalence suite for the project-owned grid A*.
 *
 * `src/core/map/astar-grid.ts` replaced rot-js's `Path.AStar` inside
 * {@link findTilePath}, which decides AI movement — so any change in
 * tie-breaking is a gameplay change. This suite pins the replacement against a
 * **verbatim transcription of rot-js 2.2.1's algorithm** (below), not against
 * hand-written expectations, so it fails the moment the ordering contract
 * drifts.
 *
 * It deliberately compares more than the returned path:
 *
 * - the **passability-probe trace** (which coordinates were tested, in order,
 *   including duplicates), because `PathfindingOptions.isTilePassable` is a
 *   caller-supplied function that is not required to be pure;
 * - behaviour from a **cold** scratch pool as well as a warm one;
 * - **reentrancy** (a predicate that itself calls back into the search) and a
 *   **throwing** predicate, which are the two ways the scratch pool could leak
 *   depth or be corrupted;
 * - alternating map dimensions, which is what forces the per-tile arrays to be
 *   resized and the generation stamps to be reset.
 */

import fc from 'fast-check';
import { Path } from 'rot-js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __forceGridAStarGenerationForTests,
  __getGridAStarLastEntryCountForTests,
  __getGridAStarScratchDepthForTests,
  __getGridAStarScratchPoolSizeForTests,
  __resetGridAStarScratchForTests,
  computeGridPath,
  type GridPassableFn,
} from '../../src/core/map/astar-grid.js';
import { findTilePath, PATH_TRAVERSAL } from '../../src/core/map/pathfinding.js';
import { makePathMap } from '../helpers/map-fixtures.js';

interface Step {
  readonly x: number;
  readonly y: number;
}

/**
 * Reference implementation: rot-js 2.2.1 `Path.AStar`, invoked exactly the way
 * `findTilePath` used to invoke it. Kept as a real rot-js call (rather than a
 * re-transcription) so the oracle cannot drift away from the library it pins.
 */
function referencePath(
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  isPassable: GridPassableFn,
): Step[] {
  const out: Step[] = [];
  const astar = new Path.AStar(goalX, goalY, isPassable, { topology: 4 });
  astar.compute(startX, startY, (x: number, y: number) => {
    out.push({ x, y });
  });
  return out;
}

function subjectPath(
  width: number,
  height: number,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  isPassable: GridPassableFn,
): Step[] {
  const out: Step[] = [];
  computeGridPath(width, height, startX, startY, goalX, goalY, isPassable, (x, y) => {
    out.push({ x, y });
  });
  return out;
}

/** Wraps a predicate so every probe coordinate is recorded, in order. */
function tracing(isPassable: GridPassableFn): { fn: GridPassableFn; trace: string[] } {
  const trace: string[] = [];
  return {
    trace,
    fn: (x, y) => {
      trace.push(`${x},${y}`);
      return isPassable(x, y);
    },
  };
}

/** A grid of `#` (wall) and `.` (floor) rows. */
function gridPredicate(rows: readonly string[]): GridPassableFn {
  return (x, y) => {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    const row = rows[y];
    if (row === undefined) return false;
    return row[x] === '.';
  };
}

/**
 * Compare subject vs reference for one fixture: path elements **and** the
 * passability-probe trace must both match exactly.
 */
function expectEquivalent(
  rows: readonly string[],
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
): void {
  const width = rows[0]?.length ?? 0;
  const height = rows.length;
  const base = gridPredicate(rows);

  const ref = tracing(base);
  const expected = referencePath(startX, startY, goalX, goalY, ref.fn);

  const sub = tracing(base);
  const actual = subjectPath(width, height, startX, startY, goalX, goalY, sub.fn);

  const label = `${startX},${startY} -> ${goalX},${goalY}`;
  expect(actual, label).toEqual(expected);
  expect(sub.trace, `${label} probe trace`).toEqual(ref.trace);
}

/** Every open cell of a grid, as `[x, y]` pairs. */
function openCells(rows: readonly string[]): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '.') cells.push([x, y]);
    }
  }
  return cells;
}

beforeEach(() => {
  __resetGridAStarScratchForTests();
});

describe('computeGridPath — exhaustive small maps', () => {
  // Every open->open pair on each of these maps, from a COLD pool on the first
  // fixture and a warm one thereafter. The 3x3 pinwheel and the 4x4 open field
  // are deliberately tie-heavy: on an open grid almost every expansion ties on
  // (f, h), so insertion order is the only thing deciding the path.
  const maps: ReadonlyArray<readonly string[]> = [
    ['...', '...', '...'],
    ['.#.', '.#.', '...'],
    ['....', '.##.', '.##.', '....'],
    ['.....', '..#..', '.#.#.', '..#..', '.....'],
    ['##', '##'],
    ['.'],
    ['..', '.#'],
    ['.....'],
    ['.', '.', '.', '.', '.'],
  ];

  for (const [index, rows] of maps.entries()) {
    it(`matches rot-js for every open pair on map #${index}`, () => {
      const cells = openCells(rows);
      for (const [sx, sy] of cells) {
        for (const [gx, gy] of cells) {
          expectEquivalent(rows, sx, sy, gx, gy);
        }
      }
    });
  }

  it('matches rot-js on a fully sealed pair (goal walled off)', () => {
    // Start is in the left pocket, goal in the right one; no route exists, so
    // the search must exhaust the reachable region and emit nothing.
    const rows = ['.#.', '.#.', '.#.'];
    expectEquivalent(rows, 0, 0, 2, 2);
    expectEquivalent(rows, 2, 0, 0, 2);
  });
});

describe('computeGridPath — randomized maps', () => {
  it('matches rot-js path and probe trace on random grids (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 14 }),
        fc.integer({ min: 2, max: 14 }),
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 0, max: 100 }),
        (width, height, seed, wallPercent) => {
          // Deterministic xorshift so a failing case is reproducible from the
          // shrunk seed alone (and so this never reaches for Math.random).
          let state = seed === 0 ? 1 : seed;
          const nextUnit = (): number => {
            state ^= state << 13;
            state >>>= 0;
            state ^= state >>> 17;
            state ^= state << 5;
            state >>>= 0;
            return state / 0x100000000;
          };

          const rows: string[] = [];
          for (let y = 0; y < height; y++) {
            let row = '';
            for (let x = 0; x < width; x++) {
              row += nextUnit() * 100 < wallPercent ? '#' : '.';
            }
            rows.push(row);
          }

          const cells = openCells(rows);
          if (cells.length === 0) return;
          // Sample a bounded number of pairs so the property stays fast while
          // still covering reachable, unreachable, and same-tile cases.
          for (let i = 0; i < 8; i++) {
            const a = cells[Math.floor(nextUnit() * cells.length)]!;
            const b = cells[Math.floor(nextUnit() * cells.length)]!;
            expectEquivalent(rows, a[0], a[1], b[0], b[1]);
          }
        },
      ),
      { numRuns: 120 },
    );
  });

  it('matches rot-js when alternating map dimensions between calls', () => {
    // Forces `sizeForMap` to reallocate and reset the generation counter
    // repeatedly; a stale-stamp bug shows up here and nowhere else.
    const wide = ['......', '.####.', '......'];
    const tall = ['...', '.#.', '.#.', '.#.', '...', '...'];
    // Same tile count as `wide` but a different shape, so the per-tile arrays
    // are NOT reallocated and only the generation counter separates the runs.
    const square = ['...', '.#.', '...', '...', '...', '...'];
    for (let i = 0; i < 6; i++) {
      expectEquivalent(wide, 0, 0, 5, 2);
      expectEquivalent(tall, 0, 0, 2, 5);
      expectEquivalent(square, 0, 0, 2, 5);
    }
  });

  it('produces the same result cold and warm', () => {
    const rows = ['.....', '.###.', '.....', '.###.', '.....'];
    __resetGridAStarScratchForTests();
    const cold = subjectPath(5, 5, 0, 0, 4, 4, gridPredicate(rows));
    const warm = subjectPath(5, 5, 0, 0, 4, 4, gridPredicate(rows));
    expect(warm).toEqual(cold);
    expect(cold).toEqual(referencePath(0, 0, 4, 4, gridPredicate(rows)));
  });
});

describe('computeGridPath — degenerate input', () => {
  const rows = ['...', '...', '...'];

  it('emits nothing for an out-of-bounds start or goal', () => {
    expect(subjectPath(3, 3, -1, 0, 2, 2, gridPredicate(rows))).toEqual([]);
    expect(subjectPath(3, 3, 0, 0, 3, 2, gridPredicate(rows))).toEqual([]);
    expect(subjectPath(3, 3, 0, 0, 2, -1, gridPredicate(rows))).toEqual([]);
  });

  it('emits nothing for an empty grid', () => {
    expect(subjectPath(0, 0, 0, 0, 0, 0, () => true)).toEqual([]);
    expect(subjectPath(3, 0, 0, 0, 0, 0, () => true)).toEqual([]);
  });

  it('emits nothing for non-integer or non-finite coordinates', () => {
    for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(subjectPath(3, 3, bad, 0, 2, 2, gridPredicate(rows)), `start.x=${bad}`).toEqual([]);
      expect(subjectPath(3, 3, 0, 0, bad, 2, gridPredicate(rows)), `goal.x=${bad}`).toEqual([]);
    }
  });

  it('emits a single step when start equals goal', () => {
    expectEquivalent(rows, 1, 1, 1, 1);
  });

  it('never indexes another row when a predicate lies about out-of-bounds tiles', () => {
    // A predicate returning true for x = -1 would, without an explicit bounds
    // guard, compute tile `y * width - 1` — a VALID index for the previous
    // row's last tile. That would silently corrupt the closed set.
    const permissive: GridPassableFn = (x, y) => x >= -1 && y >= -1 && x <= 3 && y <= 3;
    const path = subjectPath(3, 3, 0, 0, 2, 2, permissive);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 2, y: 2 });
    for (const step of path) {
      expect(step.x).toBeGreaterThanOrEqual(0);
      expect(step.x).toBeLessThan(3);
      expect(step.y).toBeGreaterThanOrEqual(0);
      expect(step.y).toBeLessThan(3);
    }
  });
});

describe('computeGridPath — scratch pool safety', () => {
  const rows = ['.....', '.###.', '.....'];

  it('stays correct when a predicate reenters the search', () => {
    // A LONG outer map, so the outer search still has a large live open list
    // when the nested call fires. If the pool ever handed both searches the same
    // scratch, the inner `beginSearch()` would reset the outer's open list and
    // the outer path would come out short, empty or wrong.
    const outerRows = ['...................', '.#################.', '...................'];
    const innerRows = ['...', '.#.', '...'];
    const expected = referencePath(0, 0, 18, 2, gridPredicate(outerRows));
    expect(expected.length).toBeGreaterThan(20);

    let depthDuringNestedSearch = -1;
    let nested = 0;
    const reentrant: GridPassableFn = (x, y) => {
      // Fires on the first expansion, while the outer open list is live.
      if (nested === 0 && x === 17 && y === 2) {
        nested += 1;
        const inner: Step[] = [];
        computeGridPath(
          3,
          3,
          0,
          0,
          2,
          2,
          (ix, iy) => {
            // Sampled from INSIDE the nested search — after it returns, its
            // `finally` has already released the slot, so an after-the-fact read
            // could not distinguish a second slot from a reused outer one.
            depthDuringNestedSearch = Math.max(
              depthDuringNestedSearch,
              __getGridAStarScratchDepthForTests(),
            );
            return gridPredicate(innerRows)(ix, iy);
          },
          (ix, iy) => {
            inner.push({ x: ix, y: iy });
          },
        );
        expect(inner[0]).toEqual({ x: 0, y: 0 });
        nested -= 1;
      }
      return gridPredicate(outerRows)(x, y);
    };

    __resetGridAStarScratchForTests();
    expect(subjectPath(19, 3, 0, 0, 18, 2, reentrant)).toEqual(expected);
    expect(depthDuringNestedSearch).toBe(2);
    // The depth counter alone would still read 2 for a pool that always handed
    // back slot 0. The POOL SIZE is what proves a second, distinct scratch
    // object was allocated for the nested search.
    expect(__getGridAStarScratchPoolSizeForTests()).toBe(2);
    expect(__getGridAStarScratchDepthForTests()).toBe(0);
  });

  it('does not leak pool depth when a predicate throws', () => {
    const boom = new Error('predicate exploded');
    const throwing: GridPassableFn = () => {
      throw boom;
    };
    for (let i = 0; i < 3; i++) {
      expect(() => subjectPath(5, 3, 0, 0, 4, 2, throwing)).toThrow(boom);
      // Asserting the DEPTH is what pins the `finally` release. Re-checking the
      // path alone would be vacuous: a leaked depth level just makes the next
      // search allocate a fresh, correctly-sized slot and still return the
      // right answer.
      expect(__getGridAStarScratchDepthForTests(), `after throw #${i + 1}`).toBe(0);
    }
    expectEquivalent(rows, 0, 0, 4, 2);
  });

  it('does not leak pool depth when the visitor throws', () => {
    const boom = new Error('visitor exploded');
    for (let i = 0; i < 3; i++) {
      expect(() =>
        computeGridPath(5, 3, 0, 0, 4, 2, gridPredicate(rows), () => {
          throw boom;
        }),
      ).toThrow(boom);
      expect(__getGridAStarScratchDepthForTests(), `after throw #${i + 1}`).toBe(0);
    }
    expectEquivalent(rows, 0, 0, 4, 2);
  });

  it('releases pool depth on every early return', () => {
    // The guard clauses return BEFORE `acquireScratch`, so these must not move
    // the depth either — a future refactor that hoists the acquire above them
    // would be caught here.
    subjectPath(3, 3, -1, 0, 2, 2, gridPredicate(rows));
    subjectPath(0, 0, 0, 0, 0, 0, () => true);
    subjectPath(3, 3, 0.5, 0, 2, 2, gridPredicate(rows));
    expect(__getGridAStarScratchDepthForTests()).toBe(0);
  });
});

describe('findTilePath — behaviour preserved end to end', () => {
  /** Runs `findTilePath` against a FloorMap, mirroring the old rot-js call. */
  function referenceFindTilePath(
    floorMap: ReturnType<typeof makePathMap>,
    start: Step,
    goal: Step,
    maxPathLength: number,
  ): Step[] {
    const passable = (x: number, y: number): boolean =>
      floorMap.tileMap.inBounds(x, y) &&
      floorMap.tileMap.isPassable(x, y) &&
      !floorMap.hasBarrierAtTile(x, y);
    if (!passable(start.x, start.y) || !passable(goal.x, goal.y)) return [];
    if (start.x === goal.x && start.y === goal.y) return [{ x: start.x, y: start.y }];

    const out: Step[] = [];
    let visited = 0;
    const astar = new Path.AStar(goal.x, goal.y, passable, { topology: 4 });
    astar.compute(start.x, start.y, (x, y) => {
      if (visited < maxPathLength) out.push({ x, y });
      visited += 1;
    });
    if (out.length === 0) return [];
    const last = out[out.length - 1]!;
    if (last.x !== goal.x || last.y !== goal.y) return [];
    return out;
  }

  it.each([1, 2, 3, 5, 7, 8, 9, 4096])(
    'matches rot-js for maxPathLength=%i (below, equal and above the true length)',
    (maxPathLength) => {
      const floorMap = makePathMap(true);
      const start = { x: 2, y: 4 };
      const goal = { x: 9, y: 4 };
      expect(findTilePath(floorMap, start, goal, { maxPathLength })).toEqual(
        referenceFindTilePath(floorMap, start, goal, maxPathLength),
      );
    },
  );

  it('routes fractional coordinates through the rot-js fallback unchanged', () => {
    // `TileMap.inBounds` accepts fractional coordinates, so a permissive
    // override can legitimately search a fractional lattice. That case must
    // still behave exactly as it did before the grid A* landed.
    const floorMap = makePathMap(false);
    const alwaysPassable = (): boolean => true;
    const start = { x: 2.5, y: 4 };
    const goal = { x: 5.5, y: 4 };

    const expected: Step[] = [];
    const astar = new Path.AStar(
      goal.x,
      goal.y,
      (x: number, y: number) =>
        floorMap.tileMap.inBounds(x, y) && alwaysPassable() && !floorMap.hasBarrierAtTile(x, y),
      { topology: 4 },
    );
    astar.compute(start.x, start.y, (x, y) => {
      expected.push({ x, y });
    });

    const actual = findTilePath(floorMap, start, goal, { isTilePassable: alwaysPassable });
    expect(actual).toEqual(expected);
    expect(actual.length).toBeGreaterThan(0);
  });

  it('still finds flying routes over walls', () => {
    const floorMap = makePathMap(false);
    const path = findTilePath(
      floorMap,
      { x: 2, y: 4 },
      { x: 9, y: 4 },
      { traversalMode: PATH_TRAVERSAL.FLYING },
    );
    expect(path[0]).toEqual({ x: 2, y: 4 });
    expect(path[path.length - 1]).toEqual({ x: 9, y: 4 });
  });
});

/**
 * Liveness pin for the dominated-duplicate open-list filter.
 *
 * The filter is **output-identical by construction** (see the "Dominated-
 * duplicate filter" section of `astar-grid.ts`), which is exactly why it needs
 * its own test: every assertion in the differential suite above stays green if
 * the filter is deleted, weakened, or accidentally disabled — the game would
 * merely get slower. A mutation run over the filter confirms this asymmetry:
 * every mutant that prunes MORE is killed by the differential suite, and every
 * mutant that prunes LESS survives it. The open-list size is the only
 * observable that separates the two.
 *
 * The counts below were measured on this exact fixture with the filter both
 * enabled and defeated, so they are a real A/B, not a vanity snapshot.
 */
describe('computeGridPath dominated-duplicate filter', () => {
  beforeEach(() => {
    __resetGridAStarScratchForTests();
  });

  /** Open grid with the start walled off, so the goal-seeded search floods
   * every tile and exhausts the open list — the duplicate-heaviest shape. */
  function exhaustiveSearch(size: number): { pathLength: number; entries: number } {
    const mid = (size - 1) >> 1;
    const isPassable: GridPassableFn = (x, y) =>
      x >= 0 && x < size && y >= 0 && y < size && Math.abs(x - mid) + Math.abs(y - mid) !== 1;
    let pathLength = 0;
    computeGridPath(size, size, mid, mid, 0, 0, isPassable, () => {
      pathLength += 1;
    });
    return { pathLength, entries: __getGridAStarLastEntryCountForTests() };
  }

  it.each([
    // size, entries WITH the filter, entries with the filter defeated
    [31, 1163, 1845],
    [41, 2053, 3265],
  ])(
    'pushes far fewer open-list entries on a %ix%i exhaustive search',
    (size, filtered, unfiltered) => {
      const result = exhaustiveSearch(size);
      // The start is sealed off, so the search must find nothing either way.
      expect(result.pathLength).toBe(0);
      expect(result.entries).toBe(filtered);
      // Guard the direction as well as the value: a regression that disabled the
      // filter would land back on `unfiltered`.
      expect(result.entries).toBeLessThan(unfiltered * 0.8);
    },
  );

  it('matches rot-js exactly on the same exhaustive fixture', () => {
    const size = 31;
    const mid = (size - 1) >> 1;
    const probes: string[] = [];
    const isPassable: GridPassableFn = (x, y) => {
      probes.push(`${x},${y}`);
      return (
        x >= 0 && x < size && y >= 0 && y < size && Math.abs(x - mid) + Math.abs(y - mid) !== 1
      );
    };
    const actual: Step[] = [];
    computeGridPath(size, size, mid, mid, 0, 0, isPassable, (x, y) => {
      actual.push({ x, y });
    });
    const actualProbes = probes.splice(0, probes.length);

    const expected = referencePath(mid, mid, 0, 0, (x, y) => {
      probes.push(`${x},${y}`);
      return (
        x >= 0 && x < size && y >= 0 && y < size && Math.abs(x - mid) + Math.abs(y - mid) !== 1
      );
    });

    expect(actual).toEqual(expected);
    expect(actualProbes).toEqual(probes);
  });
});

/**
 * The generation-stamp wrap. Both `stamp` (closed set) and `openStamp`
 * (dominated-duplicate filter) are keyed on the same monotonic counter, so a
 * wrap that cleared only one of them would let the PREVIOUS search's stamps
 * alias generation 1 and silently corrupt the next search — a stale `bestF`
 * would prune a push that is not dominated, which is a gameplay change.
 *
 * The wrap is otherwise unreachable (2^31 searches), which is why
 * `__forceGridAStarGenerationForTests` exists. Deleting the `openStamp.fill(0)`
 * line in `beginSearch` makes this test fail.
 */
describe('computeGridPath generation wrap', () => {
  it('produces rot-js-identical results on the search immediately after a wrap', () => {
    __resetGridAStarScratchForTests();
    const size = 21;
    const isPassable: GridPassableFn = (x, y) =>
      x >= 0 && x < size && y >= 0 && y < size && !(x === 10 && y !== 0);

    const collect = (sx: number, sy: number, gx: number, gy: number): Step[] => {
      const out: Step[] = [];
      computeGridPath(size, size, sx, sy, gx, gy, isPassable, (x, y) => {
        out.push({ x, y });
      });
      return out;
    };

    // Search 1 populates `stamp` and `openStamp` at generation 1.
    const warm = collect(1, 1, 19, 19);
    expect(warm).toEqual(referencePath(1, 1, 19, 19, isPassable));

    // Force the counter to the wrap boundary; the next `beginSearch` must zero
    // BOTH generation-keyed arrays and restart at generation 1.
    __forceGridAStarGenerationForTests(0x7fffffff);

    const afterWrap = collect(1, 1, 19, 19);
    expect(afterWrap).toEqual(referencePath(1, 1, 19, 19, isPassable));

    // A different endpoint pair after the wrap, so stale stamps from search 1
    // would have to be actively wrong rather than coincidentally compatible.
    __forceGridAStarGenerationForTests(0x7fffffff);
    const other = collect(19, 1, 1, 19);
    expect(other).toEqual(referencePath(19, 1, 1, 19, isPassable));
  });
});
