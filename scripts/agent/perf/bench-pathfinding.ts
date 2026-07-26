/**
 * Interleaved A/B/C/D microbench + differential oracle for `findTilePath`.
 *
 * Why this exists: `Path.AStar.compute` from rot-js was the #1 self-time frame
 * in a headless Floor-1 profile (~16% self / ~19% total per
 * `npm run perf:profile`), and 100% of it is driven by `findTilePath`. Any
 * replacement must be proven (a) faster and (b) **byte-identical** in the paths
 * it returns, because path results feed AI movement and therefore the whole
 * downstream simulation.
 *
 * Design (per the perf-optimizer skill's "commit the bench" rule, modelled on
 * `bench-fov.ts`):
 *   - BASELINE  — the pre-optimization rot-js-backed `findTilePath`, inlined
 *                 verbatim below so the comparison stays reproducible without
 *                 shipping dead code in the game.
 *   - CLOSEDSET — multi-change ablation: rot-js's open list (sorted array +
 *                 `splice` + `shift` + per-push objects), with (a) the
 *                 string-keyed `_done` object swapped for a
 *                 generation-stamped typed array AND (b) the `_getNeighbors`
 *                 array allocation removed (a direct loop interleaves
 *                 passability and closed-set checks). Measures the combined
 *                 gain from both changes, not the dict change in isolation.
 *   - CURRENT   — the live `findTilePath` (binary heap + typed arrays).
 *   - PRUNED    — CURRENT, but skipping passability probes for out-of-bounds
 *                 and already-closed neighbours. NOT shipped: `isTilePassable`
 *                 is caller-supplied and not required to be pure, so pruning
 *                 probes is only safe for pure predicates. Measured purely to
 *                 quantify what exact rot-js call-order fidelity costs.
 *
 *   - Correctness: every variant is run against every fixture in lockstep and
 *     the returned paths are compared **element by element**, not hashed.
 *   - Timing: rounds ALTERNATE which variant leads, in ONE process, so JIT
 *     warmup and machine noise hit all sides symmetrically. (A cross-process
 *     A/B previously produced a bogus 4.5x number in this repo — never trust
 *     cross-process perf deltas.) Results are reported as paired per-round
 *     ratios, so a machine-wide stall inflates every variant together instead
 *     of masking a consistent win.
 *
 * Usage:
 *   npx tsx scripts/agent/perf/bench-pathfinding.ts [rounds]
 */

import { Path } from 'rot-js';
import { query } from 'bitecs';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { Player, Position } from '../../../src/core/components.js';
import type { GameWorld } from '../../../src/core/world.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../../src/core/map/RoomGraph.js';
import { TileMap } from '../../../src/core/map/TileMap.js';
import {
  findTilePath,
  isTileTraversable,
  PATH_TRAVERSAL,
  type PathfindingOptions,
  type TilePoint,
} from '../../../src/core/map/pathfinding.js';
import { BiomeType, TilePresets, type MapConfig } from '../../../src/shared/map-types.js';
import { SeededRandom } from '../../../src/shared/random.js';

const DEFAULT_ROUNDS = 9;
/**
 * Rotated untimed sweeps per variant before timing starts.
 *
 * One sweep is NOT enough: V8 tiering is still in flight during the first timed
 * rounds, and a round-2 review reproduced medians of 4.71x, 8.13x and 8.42x for
 * the same code across three process invocations because of it. Report a range
 * across repetitions rather than a single run's median.
 */
const WARMUP_SWEEPS = 4;
const WARMUP_RUN_FRAMES = 1200;
const DEFAULT_MAX_PATH_LENGTH = 4_096;

/* ------------------------------------------------------------------ *
 * BASELINE — verbatim copy of `findTilePath` before the optimization.
 * ------------------------------------------------------------------ */

function findTilePathBaseline(
  floorMap: FloorMap,
  start: TilePoint,
  goal: TilePoint,
  options: PathfindingOptions = {},
): TilePoint[] {
  const traversalMode = options.traversalMode ?? PATH_TRAVERSAL.GROUND;
  const isTilePassable = options.isTilePassable;
  const maxPathLength = Math.max(
    1,
    options.maxPathLength ?? options.maxVisited ?? DEFAULT_MAX_PATH_LENGTH,
  );

  if (
    !floorMap.tileMap.inBounds(start.x, start.y) ||
    !floorMap.tileMap.inBounds(goal.x, goal.y) ||
    !isTileTraversable(floorMap, start.x, start.y, traversalMode, isTilePassable) ||
    !isTileTraversable(floorMap, goal.x, goal.y, traversalMode, isTilePassable)
  ) {
    return [];
  }

  if (start.x === goal.x && start.y === goal.y) {
    return [{ x: start.x, y: start.y }];
  }

  const astar = new Path.AStar(
    goal.x,
    goal.y,
    (x: number, y: number) => isTileTraversable(floorMap, x, y, traversalMode, isTilePassable),
    { topology: 4 },
  );
  const result: TilePoint[] = [];
  let visited = 0;

  astar.compute(start.x, start.y, (x: number, y: number) => {
    if (visited < maxPathLength) {
      result.push({ x, y });
    }
    visited += 1;
  });

  if (result.length === 0) {
    return [];
  }
  if (result[result.length - 1]!.x !== goal.x || result[result.length - 1]!.y !== goal.y) {
    return [];
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * ABLATION 1 (CLOSEDSET) — multi-change ablation: combines (a) the
 * string-keyed `_done` object replaced by a generation-stamped typed
 * array AND (b) the `_getNeighbors` array allocation removed (a direct
 * loop replaces the two-phase collect-then-check of rot-js). Measures
 * the combined effect of both changes, NOT the closed-set replacement
 * in isolation. The reported 5.2–5.8x is therefore a lower bound on
 * the dict-only gain rather than an exact decomposition.
 * ------------------------------------------------------------------ */

interface AblationItem {
  x: number;
  y: number;
  g: number;
  h: number;
  prev: AblationItem | null;
}

let ablationStamp = new Int32Array(0);
let ablationPrev: Array<AblationItem | null> = [];
let ablationGeneration = 0;

function computeAblationPath(
  width: number,
  height: number,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  isPassable: (x: number, y: number) => boolean,
  visit: (x: number, y: number) => void,
): void {
  const tileCount = width * height;
  if (ablationStamp.length !== tileCount) {
    ablationStamp = new Int32Array(tileCount);
    ablationPrev = new Array<AblationItem | null>(tileCount).fill(null);
    ablationGeneration = 0;
  }
  ablationGeneration += 1;
  const generation = ablationGeneration;

  const todo: AblationItem[] = [];
  const distance = (x: number, y: number): number => Math.abs(x - startX) + Math.abs(y - startY);

  const add = (x: number, y: number, prev: AblationItem | null): void => {
    const h = distance(x, y);
    const obj: AblationItem = { x, y, prev, g: prev ? prev.g + 1 : 0, h };
    const f = obj.g + obj.h;
    for (let i = 0; i < todo.length; i++) {
      const item = todo[i]!;
      const itemF = item.g + item.h;
      if (f < itemF || (f === itemF && h < item.h)) {
        todo.splice(i, 0, obj);
        return;
      }
    }
    todo.push(obj);
  };

  add(goalX, goalY, null);

  while (todo.length) {
    const item = todo.shift()!;
    const id = item.y * width + item.x;
    if (ablationStamp[id] === generation) continue;
    ablationStamp[id] = generation;
    ablationPrev[id] = item;
    if (item.x === startX && item.y === startY) break;

    for (let d = 0; d < 4; d++) {
      const nx = item.x + DIR_X[d]!;
      const ny = item.y + DIR_Y[d]!;
      if (!isPassable(nx, ny)) continue;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (ablationStamp[ny * width + nx] === generation) continue;
      add(nx, ny, item);
    }
  }

  const startId = startY * width + startX;
  if (ablationStamp[startId] !== generation) return;
  let item: AblationItem | null = ablationPrev[startId] ?? null;
  while (item) {
    visit(item.x, item.y);
    item = item.prev;
  }
}

/* ------------------------------------------------------------------ *
 * ABLATION 2 (PRUNED) — CURRENT's data structures, but skipping
 * passability probes for out-of-bounds and already-closed neighbours.
 * NOT shippable: `isTilePassable` is caller-supplied and not required to
 * be pure. Measured only to price exact rot-js call-order fidelity.
 * ------------------------------------------------------------------ */

const DIR_X = [0, 1, 0, -1] as const;
const DIR_Y = [-1, 0, 1, 0] as const;

let prunedStamp = new Int32Array(0);
let prunedPrev = new Int32Array(0);
let prunedGeneration = 0;
let prunedEntryTile = new Int32Array(256);
let prunedEntryG = new Int32Array(256);
let prunedEntryH = new Int32Array(256);
let prunedEntryF = new Int32Array(256);
let prunedEntryPrev = new Int32Array(256);
let prunedHeap = new Int32Array(256);

function computePrunedPath(
  width: number,
  height: number,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  isPassable: (x: number, y: number) => boolean,
  visit: (x: number, y: number) => void,
): void {
  const tileCount = width * height;
  if (prunedStamp.length !== tileCount) {
    prunedStamp = new Int32Array(tileCount);
    prunedPrev = new Int32Array(tileCount);
    prunedGeneration = 0;
  }
  prunedGeneration += 1;
  const generation = prunedGeneration;
  let entryCount = 0;
  let heapSize = 0;

  const grow = (): void => {
    const next = prunedEntryTile.length * 2;
    const g = (src: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> => {
      const out = new Int32Array(next);
      out.set(src);
      return out;
    };
    prunedEntryTile = g(prunedEntryTile);
    prunedEntryG = g(prunedEntryG);
    prunedEntryH = g(prunedEntryH);
    prunedEntryF = g(prunedEntryF);
    prunedEntryPrev = g(prunedEntryPrev);
    prunedHeap = g(prunedHeap);
  };

  const push = (tile: number, g: number, h: number, prev: number): void => {
    if (entryCount >= prunedEntryTile.length) grow();
    const e = entryCount++;
    const f = g + h;
    prunedEntryTile[e] = tile;
    prunedEntryG[e] = g;
    prunedEntryH[e] = h;
    prunedEntryF[e] = f;
    prunedEntryPrev[e] = prev;
    let i = heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pe = prunedHeap[parent]!;
      const pf = prunedEntryF[pe]!;
      if (pf < f) break;
      if (pf === f && prunedEntryH[pe]! <= h) break;
      prunedHeap[i] = pe;
      i = parent;
    }
    prunedHeap[i] = e;
  };

  const pop = (): number => {
    const top = prunedHeap[0]!;
    const n = --heapSize;
    if (n > 0) {
      const e = prunedHeap[n]!;
      const f = prunedEntryF[e]!;
      const h = prunedEntryH[e]!;
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        let ce = prunedHeap[child]!;
        let cf = prunedEntryF[ce]!;
        let ch = prunedEntryH[ce]!;
        const right = child + 1;
        if (right < n) {
          const re = prunedHeap[right]!;
          const rf = prunedEntryF[re]!;
          const rh = prunedEntryH[re]!;
          if (rf < cf || (rf === cf && (rh < ch || (rh === ch && re < ce)))) {
            child = right;
            ce = re;
            cf = rf;
            ch = rh;
          }
        }
        if (cf > f || (cf === f && (ch > h || (ch === h && ce > e)))) break;
        prunedHeap[i] = ce;
        i = child;
      }
      prunedHeap[i] = e;
    }
    return top;
  };

  const startTile = startY * width + startX;
  push(goalY * width + goalX, 0, Math.abs(goalX - startX) + Math.abs(goalY - startY), -1);

  while (heapSize > 0) {
    const e = pop();
    const tile = prunedEntryTile[e]!;
    if (prunedStamp[tile] === generation) continue;
    prunedStamp[tile] = generation;
    prunedPrev[tile] = prunedEntryPrev[e]!;
    if (tile === startTile) break;
    const y = (tile / width) | 0;
    const x = tile - y * width;
    const nextG = prunedEntryG[e]! + 1;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_X[d]!;
      const ny = y + DIR_Y[d]!;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighborTile = ny * width + nx;
      if (prunedStamp[neighborTile] === generation) continue;
      if (!isPassable(nx, ny)) continue;
      push(neighborTile, nextG, Math.abs(nx - startX) + Math.abs(ny - startY), tile);
    }
  }

  if (prunedStamp[startTile] !== generation) return;
  let tile = startTile;
  while (tile >= 0) {
    const y = (tile / width) | 0;
    visit(tile - y * width, y);
    tile = prunedPrev[tile]!;
  }
}

/**
 * Wrap a raw grid-path routine in `findTilePath`'s exact outer contract so the
 * ablations are compared like-for-like with BASELINE and CURRENT.
 */
function makeFindTilePathVariant(
  compute: (
    width: number,
    height: number,
    startX: number,
    startY: number,
    goalX: number,
    goalY: number,
    isPassable: (x: number, y: number) => boolean,
    visit: (x: number, y: number) => void,
  ) => void,
): (
  floorMap: FloorMap,
  start: TilePoint,
  goal: TilePoint,
  options?: PathfindingOptions,
) => TilePoint[] {
  return (floorMap, start, goal, options = {}) => {
    const traversalMode = options.traversalMode ?? PATH_TRAVERSAL.GROUND;
    const isTilePassable = options.isTilePassable;
    const maxPathLength = Math.max(
      1,
      options.maxPathLength ?? options.maxVisited ?? DEFAULT_MAX_PATH_LENGTH,
    );

    if (
      !floorMap.tileMap.inBounds(start.x, start.y) ||
      !floorMap.tileMap.inBounds(goal.x, goal.y) ||
      !isTileTraversable(floorMap, start.x, start.y, traversalMode, isTilePassable) ||
      !isTileTraversable(floorMap, goal.x, goal.y, traversalMode, isTilePassable)
    ) {
      return [];
    }
    if (start.x === goal.x && start.y === goal.y) {
      return [{ x: start.x, y: start.y }];
    }

    const result: TilePoint[] = [];
    let visited = 0;
    compute(
      floorMap.tileMap.width,
      floorMap.tileMap.height,
      start.x,
      start.y,
      goal.x,
      goal.y,
      (x, y) => isTileTraversable(floorMap, x, y, traversalMode, isTilePassable),
      (x, y) => {
        if (visited < maxPathLength) result.push({ x, y });
        visited += 1;
      },
    );

    if (result.length === 0) return [];
    const last = result[result.length - 1]!;
    if (last.x !== goal.x || last.y !== goal.y) return [];
    return result;
  };
}

const findTilePathClosedSet = makeFindTilePathVariant(computeAblationPath);
const findTilePathPruned = makeFindTilePathVariant(computePrunedPath);

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

interface PathCase {
  readonly floorMap: FloorMap;
  readonly start: TilePoint;
  readonly goal: TilePoint;
  readonly options: PathfindingOptions;
  readonly label: string;
}

function makeConfig(widthTiles: number, heightTiles: number, seed: number): MapConfig {
  return {
    widthTiles,
    heightTiles,
    tileSizeFt: 32,
    biome: BiomeType.ARENA,
    seed,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
}

/** Random wall-noise map with a solid border, built from `SeededRandom`. */
function makeRandomMap(width: number, height: number, wallChance: number, seed: number): FloorMap {
  const rng = new SeededRandom(seed);
  const tileMap = new TileMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      tileMap.flags[y * width + x] =
        border || rng.next() < wallChance ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  return new FloorMap(
    makeConfig(width, height, seed),
    tileMap,
    new RoomGraph(),
    new Uint8Array(width * height),
    { x: 1, y: 1 },
  );
}

function passableTiles(floorMap: FloorMap): TilePoint[] {
  const out: TilePoint[] = [];
  const { width, height } = floorMap.tileMap;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (floorMap.tileMap.isPassable(x, y)) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Randomized correctness fixtures: many random maps x many random pairs, plus
 * every enumerated edge case (same tile, adjacent, out-of-bounds, unreachable,
 * flying traversal, `isTilePassable` override, and `maxPathLength` below /
 * equal to / above the true path length).
 */
function buildOracleCases(): PathCase[] {
  const cases: PathCase[] = [];
  const rng = new SeededRandom(0xc0ffee);

  const shapes: Array<[number, number, number]> = [
    [8, 8, 0.15],
    [12, 9, 0.25],
    [17, 13, 0.3],
    [24, 16, 0.35],
    [31, 23, 0.2],
    [40, 40, 0.28],
  ];

  for (let m = 0; m < 30; m++) {
    const [w, h, density] = shapes[m % shapes.length]!;
    const floorMap = makeRandomMap(w, h, density, 1000 + m);
    const open = passableTiles(floorMap);
    if (open.length < 2) continue;

    for (let i = 0; i < 25; i++) {
      const start = open[rng.nextInt(0, open.length - 1)]!;
      const goal = open[rng.nextInt(0, open.length - 1)]!;
      cases.push({ floorMap, start, goal, options: {}, label: `rand-${m}-${i}` });
    }

    // Edge cases on this map.
    const a = open[0]!;
    const b = open[open.length - 1]!;
    cases.push({ floorMap, start: a, goal: a, options: {}, label: `same-${m}` });
    cases.push({
      floorMap,
      start: a,
      goal: { x: a.x + 1, y: a.y },
      options: {},
      label: `adjacent-${m}`,
    });
    cases.push({ floorMap, start: { x: -1, y: 0 }, goal: b, options: {}, label: `oob-start-${m}` });
    cases.push({
      floorMap,
      start: a,
      goal: { x: w + 5, y: h + 5 },
      options: {},
      label: `oob-goal-${m}`,
    });
    cases.push({
      floorMap,
      start: a,
      goal: b,
      options: { traversalMode: PATH_TRAVERSAL.FLYING },
      label: `flying-${m}`,
    });
    // Passability override that seals the right half — guarantees plenty of
    // genuinely unreachable searches (the expensive full-flood case).
    const half = Math.floor(w / 2);
    cases.push({
      floorMap,
      start: { x: 1, y: 1 },
      goal: { x: w - 2, y: h - 2 },
      options: { isTilePassable: (x, y) => x !== half && floorMap.tileMap.isPassable(x, y) },
      label: `sealed-${m}`,
    });
    for (const cap of [1, 2, 3, 5, 8, 4096]) {
      cases.push({
        floorMap,
        start: a,
        goal: b,
        options: { maxPathLength: cap },
        label: `cap${cap}-${m}`,
      });
    }
  }

  return cases;
}

/** Build a real Floor-1 map by running the headless AI briefly. */
async function buildFloorOneMap(seed: number): Promise<FloorMap> {
  let captured: GameWorld | undefined;
  const ai = new BehaviorTreeAI({ seed });
  await runHeadless(ai, {
    seed,
    maxFrames: WARMUP_RUN_FRAMES,
    forceWeaponId: 'sword',
    questStallFrames: 0,
    onFinish: (w) => {
      captured = w;
    },
    simulationOptions: {
      preSystems: [
        (w: GameWorld) => {
          // Touch the player query so the run behaves like a normal sim step.
          query(w.ecs, [Player, Position]);
        },
      ],
    },
  });
  if (!captured?.floorMap) throw new Error('bench-pathfinding: headless run surfaced no floorMap');
  return captured.floorMap;
}

/**
 * Timing workload on the REAL Floor-1 geometry: reachable pairs across the
 * whole map plus a block of genuinely unreachable searches (a sealed column),
 * which are the full-flood worst case the AI hits when a goal is walled off.
 */
function buildTimingCases(floorMap: FloorMap): { reachable: PathCase[]; unreachable: PathCase[] } {
  const open = passableTiles(floorMap);
  const rng = new SeededRandom(0x5eed);
  const reachable: PathCase[] = [];
  for (let i = 0; i < 300; i++) {
    reachable.push({
      floorMap,
      start: open[rng.nextInt(0, open.length - 1)]!,
      goal: open[rng.nextInt(0, open.length - 1)]!,
      options: {},
      label: `floor1-${i}`,
    });
  }

  const width = floorMap.tileMap.width;
  const sealed = Math.floor(width / 2);
  const sealedPassable = (x: number, y: number): boolean =>
    x !== sealed && floorMap.tileMap.isPassable(x, y);
  const left = open.filter((t) => t.x < sealed);
  const right = open.filter((t) => t.x > sealed);
  const unreachable: PathCase[] = [];
  for (let i = 0; i < 40 && left.length > 0 && right.length > 0; i++) {
    unreachable.push({
      floorMap,
      start: left[rng.nextInt(0, left.length - 1)]!,
      goal: right[rng.nextInt(0, right.length - 1)]!,
      options: { isTilePassable: sealedPassable },
      label: `floor1-sealed-${i}`,
    });
  }
  return { reachable, unreachable };
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

type Variant = (
  floorMap: FloorMap,
  start: TilePoint,
  goal: TilePoint,
  options?: PathfindingOptions,
) => TilePoint[];

interface NamedVariant {
  readonly name: string;
  readonly run: Variant;
}

/** Element-by-element path comparison (never a hash — collisions are real). */
function pathsDiffer(a: readonly TilePoint[], b: readonly TilePoint[]): string | null {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.x !== b[i]!.x || a[i]!.y !== b[i]!.y) {
      return `step ${i}: (${a[i]!.x},${a[i]!.y}) vs (${b[i]!.x},${b[i]!.y})`;
    }
  }
  return null;
}

function checkEquivalence(cases: readonly PathCase[], variants: readonly NamedVariant[]): boolean {
  let ok = true;
  let compared = 0;
  let nonEmpty = 0;
  for (const c of cases) {
    const expected = findTilePathBaseline(c.floorMap, c.start, c.goal, c.options);
    if (expected.length > 0) nonEmpty += 1;
    for (const v of variants) {
      const actual = v.run(c.floorMap, c.start, c.goal, c.options);
      const diff = pathsDiffer(expected, actual);
      compared += 1;
      if (diff) {
        console.error(`❌ ${v.name} diverged on "${c.label}": ${diff}`);
        ok = false;
        return ok;
      }
    }
  }
  if (ok) {
    console.log(
      `✅ Equivalence: ${compared} comparisons across ${cases.length} fixtures ` +
        `(${nonEmpty} returned a non-empty path) — all byte-identical to rot-js.`,
    );
  }
  return ok;
}

function timeVariant(cases: readonly PathCase[], variant: Variant): number {
  const start = process.hrtime.bigint();
  let sink = 0;
  for (const c of cases) {
    sink += variant(c.floorMap, c.start, c.goal, c.options).length;
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  if (sink < 0) throw new Error('unreachable');
  return elapsed;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function runPanel(
  title: string,
  cases: readonly PathCase[],
  variants: readonly NamedVariant[],
  rounds: number,
): void {
  if (cases.length === 0) {
    console.log(`\n${title}: no cases — skipped.`);
    return;
  }
  const samples = variants.map(() => [] as number[]);
  /*
   * Warm up with SEVERAL rotated sweeps, not one. A single sweep leaves V8 in a
   * lower tier for the first timed rounds, which is what made an earlier version
   * of this bench report a median anywhere between 4.7x and 8.4x across process
   * invocations. Rotating the warmup the same way the timed rounds rotate keeps
   * the tiering pressure symmetric across variants.
   */
  for (let w = 0; w < WARMUP_SWEEPS; w++) {
    for (let i = 0; i < variants.length; i++) {
      const idx = (w + i) % variants.length;
      timeVariant(cases, variants[idx]!.run);
    }
  }

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < variants.length; i++) {
      // Rotate which variant leads each round so ordering effects cancel out.
      const idx = (r + i) % variants.length;
      samples[idx]!.push(timeVariant(cases, variants[idx]!.run));
    }
  }

  const toUsPerCall = (ms: number): number => (ms * 1000) / cases.length;
  console.log(`\n${title} — ${rounds} rounds x ${cases.length} calls (us/call):`);
  for (let i = 0; i < variants.length; i++) {
    const s = samples[i]!;
    console.log(
      `  ${variants[i]!.name.padEnd(10)} median ${toUsPerCall(median(s)).toFixed(2)}  ` +
        `[best ${toUsPerCall(Math.min(...s)).toFixed(2)}, worst ${toUsPerCall(Math.max(...s)).toFixed(2)}]`,
    );
  }

  /*
   * Paired per-round ratios, not raw distributions. All variants run inside the
   * same round, so a machine-wide stall inflates every one of them together and
   * comparing raw min/max would report "overlapping" for a real, consistent
   * win. If the WORST round still shows a ratio > 1, the win held every round.
   */
  console.log('  Paired per-round ratios vs BASELINE (immune to machine-wide stalls):');
  const baselineSamples = samples[0]!;
  for (let i = 1; i < variants.length; i++) {
    const ratios = baselineSamples.map((b, r) => b / samples[i]![r]!);
    const worst = Math.min(...ratios);
    const won = ratios.filter((x) => x > 1).length;
    console.log(
      `    ${variants[i]!.name.padEnd(10)} ${median(ratios).toFixed(2)}x median  ` +
        `[worst round ${worst.toFixed(2)}x, best ${Math.max(...ratios).toFixed(2)}x]  ` +
        `${won}/${ratios.length} rounds won${worst > 1 ? '  ✅' : '  ⚠️'}`,
    );
  }
}

async function main(): Promise<void> {
  const rounds = Number(process.argv[2] ?? DEFAULT_ROUNDS);
  if (!Number.isFinite(rounds) || rounds <= 0) {
    throw new Error(`bench-pathfinding: invalid round count "${process.argv[2]}"`);
  }

  const variants: NamedVariant[] = [
    { name: 'BASELINE', run: findTilePathBaseline },
    { name: 'CLOSEDSET', run: findTilePathClosedSet },
    { name: 'CURRENT', run: findTilePath },
    { name: 'PRUNED', run: findTilePathPruned },
  ];
  const compared = variants.slice(1);

  console.log('Differential oracle: randomized maps + enumerated edge cases...');
  const oracleCases = buildOracleCases();
  if (!checkEquivalence(oracleCases, compared)) {
    process.exitCode = 1;
    return;
  }

  console.log('\nBuilding a real Floor-1 map (headless warmup run)...');
  const floorMap = await buildFloorOneMap(1);
  const timing = buildTimingCases(floorMap);
  console.log(
    `Floor 1: ${floorMap.tileMap.width}x${floorMap.tileMap.height} tiles, ` +
      `${timing.reachable.length} reachable pairs, ${timing.unreachable.length} sealed pairs.`,
  );

  console.log('\nDifferential oracle: real Floor-1 geometry...');
  if (!checkEquivalence([...timing.reachable, ...timing.unreachable], compared)) {
    process.exitCode = 1;
    return;
  }

  runPanel('Floor-1 reachable searches', timing.reachable, variants, rounds);
  runPanel('Floor-1 unreachable (sealed) searches', timing.unreachable, variants, rounds);

  console.log(
    '\nNote: PRUNED is NOT shipped. It skips passability probes for out-of-bounds and\n' +
      'already-closed neighbours, which is only safe when `isTilePassable` is pure —\n' +
      'the public option type does not require that. Its gap over CURRENT is the price\n' +
      'of exact rot-js call-order fidelity.',
  );
}

await main();
