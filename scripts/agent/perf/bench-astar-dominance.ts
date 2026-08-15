/**
 * Interleaved A/B microbench + differential oracle for the **dominated-
 * duplicate open-list filter** in `computeGridPath` (`src/core/map/astar-grid.ts`).
 *
 * ## Why this exists
 *
 * `computeGridPath` is the top game-code frame in the headless Floor-1 profile
 * (`npm run perf:profile` on 2026-08-15: **6.00% self / 8.27% total**), now that
 * the rot-js A* replacement, the empty-barrier fast path and the flow-field pass
 * have all landed.
 *
 * Instrumenting a real seeds 1-3 x sword panel showed where its time goes:
 *
 * ```
 * computeGridPath calls        8,490
 * open-list pushes        10,412,514
 * open-list pops           9,958,819   of which 4,141,050 (41.6%) are STALE
 * dominated pushes         2,782,898   = 26.7% of all pushes
 * ```
 *
 * A *dominated* push is one where the same tile already has an open entry
 * ordered strictly earlier under `(f asc, h asc, entryId asc)`. Such an entry
 * can only ever be popped as a bare `continue` (see the module header of
 * `astar-grid.ts` for the four-step argument). Dropping it removes a heap push
 * AND the matching stale heap pop, without touching the expanded sequence, the
 * emitted path, or the ordered `isPassable` probe trace.
 *
 * ## Variants
 *
 *   - BASELINE — a **verbatim copy** of the pre-change `computeGridPath` and its
 *                scratch class, inlined below (with symbols renamed and its own
 *                private scratch pool) so this comparison stays reproducible
 *                after the source changes.
 *   - CURRENT  — the live `computeGridPath`.
 *
 * ## Correctness — differential oracle
 *
 * Run **after** all timing, so the extra receiver shapes and tracing closures
 * cannot perturb V8 tiering in the timed loops. For every fixture it compares:
 *
 *   1. the emitted path, **tile by tile** (never a hash), and
 *   2. the **ordered `isPassable` probe trace**, entry by entry.
 *
 * Comparing paths alone would be insufficient: `isTilePassable` is caller-
 * supplied on `PathfindingOptions` and is not required to be pure, so a variant
 * that pruned "redundant" probes would return identical paths while changing
 * what a stateful predicate observes. That is exactly the contract
 * `astar-grid.ts` documents, so it is exactly what is asserted here.
 *
 * The oracle covers reachable pairs, deliberately sealed/unreachable goals, and
 * degenerate start === goal cases, on two independently generated real Floor-1
 * maps.
 *
 * ## Timing method
 *
 * Rounds ALTERNATE which variant leads, in ONE process, after
 * {@link WARMUP_SWEEPS} rotated untimed sweeps. A cross-process A/B once
 * produced a bogus 4.5x in this repo, and a single warmup sweep once swung the
 * median between 4.7x and 8.4x for byte-identical code — hence four sweeps and
 * paired per-round ratios.
 *
 * Report the **worst paired round** and the **rounds won**, over a RANGE of at
 * least two separate process invocations. Never quote a single run's best.
 *
 * Usage:
 *   npx tsx scripts/agent/perf/bench-astar-dominance.ts [rounds]
 */

import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import type { GameWorld } from '../../../src/core/world.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import {
  computeGridPath,
  type GridPassableFn,
  type GridPathVisitor,
} from '../../../src/core/map/astar-grid.js';
import { isTileTraversable, PATH_TRAVERSAL } from '../../../src/core/map/pathfinding.js';
import { SeededRandom } from '../../../src/shared/random.js';

const DEFAULT_ROUNDS = 15;
/**
 * Rotated untimed sweeps per variant before timing starts. One sweep is NOT
 * enough — V8 tiering is still in flight during the first timed rounds. See
 * `bench-pathfinding.ts` for the incident that established this floor.
 */
const WARMUP_SWEEPS = 4;
const WARMUP_RUN_FRAMES = 1200;
/** Searches per timed round, sized so one round takes ~10-25 ms. */
const SEARCHES_PER_MAP = 90;

// ---------------------------------------------------------------------------
// BASELINE — verbatim copy of `src/core/map/astar-grid.ts` as of the parent of
// this change. Only symbol names differ (to avoid clashing with the live
// import) and it carries its own scratch pool. Do not "tidy" it: its value is
// that it is byte-equivalent to the shipped predecessor.
// ---------------------------------------------------------------------------

/** Neighbour offsets in rot-js `DIRS[4]` order: N, E, S, W. */
const BASE_DIR_X = [0, 1, 0, -1] as const;
const BASE_DIR_Y = [-1, 0, 1, 0] as const;
const INITIAL_ENTRY_CAPACITY = 256;
const MAX_GENERATION = 0x7fffffff;

class BaselineScratch {
  /** Tile count the per-tile arrays are currently sized for. */
  tileCount = 0;
  /** Generation stamp per tile; `stamp[t] === generation` means "closed". */
  stamp = new Int32Array(0);
  /** Tile index this tile was closed from, or -1 for the goal seed. */
  prevTile = new Int32Array(0);
  /** Monotonic search counter, so the closed set never needs clearing. */
  generation = 0;

  /** Open-list entries, appended in push order (index === insertion sequence). */
  entryTile = new Int32Array(INITIAL_ENTRY_CAPACITY);
  entryG = new Int32Array(INITIAL_ENTRY_CAPACITY);
  entryH = new Int32Array(INITIAL_ENTRY_CAPACITY);
  entryF = new Int32Array(INITIAL_ENTRY_CAPACITY);
  entryPrev = new Int32Array(INITIAL_ENTRY_CAPACITY);
  /** Binary min-heap of entry ids. */
  heap = new Int32Array(INITIAL_ENTRY_CAPACITY);
  entryCount = 0;
  heapSize = 0;
  /** Per-expansion N/E/S/W passability probes; reused, never escapes. */
  readonly neighborPassable = new Uint8Array(4);

  /** Ensure the per-tile arrays match this map's tile count. */
  sizeForMap(tileCount: number): void {
    if (this.tileCount === tileCount) return;
    this.stamp = new Int32Array(tileCount);
    this.prevTile = new Int32Array(tileCount);
    this.tileCount = tileCount;
    // Fresh arrays are all-zero, so the next generation must not be 0.
    this.generation = 0;
  }

  /** Start a new search: bump the generation, reset the open list. */
  beginSearch(): void {
    if (this.generation >= MAX_GENERATION) {
      this.stamp.fill(0);
      this.generation = 0;
    }
    this.generation += 1;
    this.entryCount = 0;
    this.heapSize = 0;
  }

  /** Double the open-list capacity. */
  private growEntries(): void {
    const next = this.entryTile.length * 2;
    const grow = (src: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> => {
      const out = new Int32Array(next);
      out.set(src);
      return out;
    };
    this.entryTile = grow(this.entryTile);
    this.entryG = grow(this.entryG);
    this.entryH = grow(this.entryH);
    this.entryF = grow(this.entryF);
    this.entryPrev = grow(this.entryPrev);
    this.heap = grow(this.heap);
  }

  /**
   * Push an open-list entry, sifting it up by `(f asc, h asc, entryId asc)`.
   *
   * The new entry always has the largest id, so the `entryId` tiebreak makes a
   * tie *stop* the sift — reproducing rot-js's "insert after everything you tie
   * with" FIFO behaviour.
   */
  push(tile: number, g: number, h: number, prev: number): void {
    if (this.entryCount >= this.entryTile.length) this.growEntries();
    const e = this.entryCount++;
    const f = g + h;
    this.entryTile[e] = tile;
    this.entryG[e] = g;
    this.entryH[e] = h;
    this.entryF[e] = f;
    this.entryPrev[e] = prev;

    const heap = this.heap;
    const entryF = this.entryF;
    const entryH = this.entryH;
    let i = this.heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pe = heap[parent]!;
      const pf = entryF[pe]!;
      if (pf < f) break;
      if (pf === f) {
        const ph = entryH[pe]!;
        if (ph < h) break;
        // Equal (f, h): the parent was inserted earlier, so it wins.
        if (ph === h) break;
      }
      heap[i] = pe;
      i = parent;
    }
    heap[i] = e;
  }

  /** Pop the minimum entry id by `(f asc, h asc, entryId asc)`. */
  pop(): number {
    const heap = this.heap;
    const entryF = this.entryF;
    const entryH = this.entryH;
    const top = heap[0]!;
    const n = --this.heapSize;
    if (n > 0) {
      const e = heap[n]!;
      const f = entryF[e]!;
      const h = entryH[e]!;
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        let ce = heap[child]!;
        let cf = entryF[ce]!;
        let ch = entryH[ce]!;
        const right = child + 1;
        if (right < n) {
          const re = heap[right]!;
          const rf = entryF[re]!;
          const rh = entryH[re]!;
          if (rf < cf || (rf === cf && (rh < ch || (rh === ch && re < ce)))) {
            child = right;
            ce = re;
            cf = rf;
            ch = rh;
          }
        }
        if (cf > f || (cf === f && (ch > h || (ch === h && ce > e)))) break;
        heap[i] = ce;
        i = child;
      }
      heap[i] = e;
    }
    return top;
  }
}

/**
 * Depth-indexed scratch pool. Index 0 serves the common non-nested case; a
 * reentrant call takes index 1, and so on. Never exposed outside this module.
 */
const baselineScratchPool: BaselineScratch[] = [];
let baselineScratchDepth = 0;

function acquireBaselineScratch(): BaselineScratch {
  let scratch = baselineScratchPool[baselineScratchDepth];
  if (scratch === undefined) {
    scratch = new BaselineScratch();
    baselineScratchPool[baselineScratchDepth] = scratch;
  }
  baselineScratchDepth += 1;
  return scratch;
}

function releaseBaselineScratch(): void {
  baselineScratchDepth -= 1;
}

/**
 * Compute a 4-connected A* path and emit it, start → goal, through `visit`.
 *
 * Behaviourally identical to
 * `new Path.AStar(goalX, goalY, isPassable, { topology: 4 }).compute(startX, startY, visit)`
 * from rot-js 2.2.1, including tie-breaking. When the goal is unreachable from
 * the start, `visit` is never called.
 *
 * The goal tile itself is **not** passability-tested (rot-js seeds the open
 * list unconditionally); callers validate their endpoints first.
 *
 * @param width  Grid width in tiles; must be > 0.
 * @param height Grid height in tiles; must be > 0.
 * @param isPassable Called once per neighbour per expansion, for all four
 *   directions in N/E/S/W order, before any of them is enqueued — exactly as
 *   rot-js does. It may be stateful; this module does not skip probes to save
 *   work. It is expected to return `false` for every coordinate outside
 *   `[0, width) × [0, height)` (as `isTileTraversable` does); out-of-bounds
 *   neighbours are additionally rejected here so a tile index is always safe
 *   to compute.
 *
 * All six coordinates must be integers — tile indices address typed arrays, so
 * a fractional coordinate has no slot to stamp and the search could not
 * terminate. Non-integer input returns without visiting; `findTilePath` routes
 * such calls to its rot-js fallback instead, so this guard is a safety net
 * rather than a behavioural contract change.
 */
function computeGridPathBaseline(
  width: number,
  height: number,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  isPassable: GridPassableFn,
  visit: GridPathVisitor,
): void {
  const tileCount = width * height;
  if (tileCount <= 0) return;
  if (startX < 0 || startX >= width || startY < 0 || startY >= height) return;
  if (goalX < 0 || goalX >= width || goalY < 0 || goalY >= height) return;
  if (
    !Number.isInteger(startX) ||
    !Number.isInteger(startY) ||
    !Number.isInteger(goalX) ||
    !Number.isInteger(goalY) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    return;
  }

  const scratch = acquireBaselineScratch();
  try {
    scratch.sizeForMap(tileCount);
    scratch.beginSearch();

    const generation = scratch.generation;
    const stamp = scratch.stamp;
    const prevTile = scratch.prevTile;
    const startTile = startY * width + startX;

    // Seed with the GOAL: g = 0, h = Manhattan distance to the START.
    scratch.push(goalY * width + goalX, 0, Math.abs(goalX - startX) + Math.abs(goalY - startY), -1);

    while (scratch.heapSize > 0) {
      const e = scratch.pop();
      const tile = scratch.entryTile[e]!;
      if (stamp[tile] === generation) continue;
      stamp[tile] = generation;
      prevTile[tile] = scratch.entryPrev[e]!;
      if (tile === startTile) break;

      const y = (tile / width) | 0;
      const x = tile - y * width;
      const nextG = scratch.entryG[e]! + 1;

      // rot-js's `_getNeighbors` probes ALL four directions before the caller
      // checks the closed set, so every probe happens first, in N/E/S/W order,
      // even for out-of-bounds or already-closed tiles. A caller-supplied
      // `isTilePassable` is not required to be pure, so this call pattern is
      // reproduced exactly rather than pruned.
      const passable = scratch.neighborPassable;
      passable[0] = isPassable(x, y - 1) ? 1 : 0;
      passable[1] = isPassable(x + 1, y) ? 1 : 0;
      passable[2] = isPassable(x, y + 1) ? 1 : 0;
      passable[3] = isPassable(x - 1, y) ? 1 : 0;

      for (let d = 0; d < 4; d++) {
        if (passable[d] === 0) continue;
        const nx = x + BASE_DIR_X[d]!;
        const ny = y + BASE_DIR_Y[d]!;
        // `isTileTraversable` already rejects out-of-bounds tiles, so this is
        // a safety net that keeps the tile index in range for any predicate.
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighborTile = ny * width + nx;
        if (stamp[neighborTile] === generation) continue;
        scratch.push(neighborTile, nextG, Math.abs(nx - startX) + Math.abs(ny - startY), tile);
      }
    }

    if (stamp[startTile] !== generation) return;

    // Walk the closed-set predecessor chain from the start back to the goal.
    // Every predecessor was itself popped and closed before it expanded, so
    // the chain is fully populated for this generation.
    let tile = startTile;
    while (tile >= 0) {
      const y = (tile / width) | 0;
      visit(tile - y * width, y);
      tile = prevTile[tile]!;
    }
  } finally {
    releaseBaselineScratch();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type PathVariant = (
  width: number,
  height: number,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  isPassable: (x: number, y: number) => boolean,
  visit: (x: number, y: number) => void,
) => void;

interface NamedVariant {
  readonly name: string;
  readonly run: PathVariant;
}

interface SearchCase {
  readonly label: string;
  readonly floorMap: FloorMap;
  readonly startX: number;
  readonly startY: number;
  readonly goalX: number;
  readonly goalY: number;
  /**
   * When true the predicate additionally refuses the four tiles orthogonally
   * adjacent to the start, walling the start off from the rest of the floor.
   * The search is seeded at the GOAL, so this forces it to flood the entire
   * connected region and exhaust the open list without ever popping the start —
   * the exhaustive/unreachable shape, and the one with the most duplicate
   * open-list entries.
   */
  readonly sealStart?: boolean;
}

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
  });
  if (!captured?.floorMap) {
    throw new Error('bench-astar-dominance: headless run surfaced no floorMap');
  }
  return captured.floorMap;
}

function passableTiles(floorMap: FloorMap): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < floorMap.tileMap.height; y += 1) {
    for (let x = 0; x < floorMap.tileMap.width; x += 1) {
      if (isTileTraversable(floorMap, x, y, PATH_TRAVERSAL.GROUND)) out.push({ x, y });
    }
  }
  return out;
}

function makePassable(c: SearchCase): (x: number, y: number) => boolean {
  const floorMap = c.floorMap;
  if (c.sealStart !== true) {
    return (x: number, y: number): boolean =>
      isTileTraversable(floorMap, x, y, PATH_TRAVERSAL.GROUND);
  }
  const sx = c.startX;
  const sy = c.startY;
  return (x: number, y: number): boolean => {
    if (Math.abs(x - sx) + Math.abs(y - sy) === 1) return false;
    return isTileTraversable(floorMap, x, y, PATH_TRAVERSAL.GROUND);
  };
}

function buildCases(floorMap: FloorMap, seed: number, total: number, prefix: string): SearchCase[] {
  const tiles = passableTiles(floorMap);
  if (tiles.length === 0) throw new Error('bench-astar-dominance: no traversable tiles');
  const rng = new SeededRandom(seed);
  const cases: SearchCase[] = [];
  for (let i = 0; i < total; i += 1) {
    const start = tiles[rng.nextInt(0, tiles.length - 1)]!;
    const goal = tiles[rng.nextInt(0, tiles.length - 1)]!;
    cases.push({
      label: `${prefix}-${i}`,
      floorMap,
      startX: start.x,
      startY: start.y,
      goalX: goal.x,
      goalY: goal.y,
    });
  }
  return cases;
}

/**
 * Exhaustive/unreachable fixtures: a real start whose four neighbours the
 * predicate refuses, so the goal-seeded search floods the whole connected
 * region and empties the open list without ever popping the start. This is the
 * most duplicate-heavy shape the search sees, so it gets its own panel.
 */
function buildUnreachableCases(
  floorMap: FloorMap,
  seed: number,
  total: number,
  prefix: string,
): SearchCase[] {
  return buildCases(floorMap, seed, total, `${prefix}-unreachable`).map((c) => ({
    ...c,
    sealStart: true,
  }));
}

function runWithTrace(c: SearchCase, variant: PathVariant): { path: number[]; trace: number[] } {
  const path: number[] = [];
  const trace: number[] = [];
  const passable = makePassable(c);
  variant(
    c.floorMap.tileMap.width,
    c.floorMap.tileMap.height,
    c.startX,
    c.startY,
    c.goalX,
    c.goalY,
    (x, y) => {
      trace.push(x, y);
      return passable(x, y);
    },
    (x, y) => {
      path.push(x, y);
    },
  );
  return { path, trace };
}

function seqDiffer(
  what: string,
  expected: readonly number[],
  actual: readonly number[],
): string | null {
  if (expected.length !== actual.length) {
    return `${what} length ${expected.length} vs ${actual.length}`;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] !== actual[i]) return `${what}[${i}] ${expected[i]} vs ${actual[i]}`;
  }
  return null;
}

function checkEquivalence(
  cases: readonly SearchCase[],
  variants: readonly NamedVariant[],
): boolean {
  let pathChecks = 0;
  let traceEntries = 0;
  for (const c of cases) {
    const expected = runWithTrace(c, computeGridPathBaseline);
    traceEntries += expected.trace.length / 2;
    for (const variant of variants) {
      const actual = runWithTrace(c, variant.run);
      const pathDiff = seqDiffer('path', expected.path, actual.path);
      pathChecks += 1;
      if (pathDiff !== null) {
        console.error(`❌ ${variant.name} path diverged on "${c.label}": ${pathDiff}`);
        return false;
      }
      const traceDiff = seqDiffer('probe trace', expected.trace, actual.trace);
      if (traceDiff !== null) {
        console.error(`❌ ${variant.name} probe trace diverged on "${c.label}": ${traceDiff}`);
        return false;
      }
    }
  }
  console.log(
    `✅ Post-timing oracle: ${pathChecks} path comparisons and ${pathChecks} ordered probe-trace ` +
      `comparisons across ${cases.length} fixtures (${traceEntries} baseline probes) — all exact.`,
  );
  return true;
}

function timeVariant(cases: readonly SearchCase[], variant: PathVariant): number {
  let sink = 0;
  const start = process.hrtime.bigint();
  for (const c of cases) {
    const passable = makePassable(c);
    variant(
      c.floorMap.tileMap.width,
      c.floorMap.tileMap.height,
      c.startX,
      c.startY,
      c.goalX,
      c.goalY,
      passable,
      (x, y) => {
        sink += x + y;
      },
    );
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  if (sink === Number.MAX_SAFE_INTEGER) throw new Error('unreachable');
  return elapsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function runPanel(
  title: string,
  cases: readonly SearchCase[],
  variants: readonly NamedVariant[],
  rounds: number,
): void {
  const samples = variants.map(() => [] as number[]);
  for (let w = 0; w < WARMUP_SWEEPS; w += 1) {
    for (let i = 0; i < variants.length; i += 1) {
      const idx = (w + i) % variants.length;
      timeVariant(cases, variants[idx]!.run);
    }
  }
  for (let round = 0; round < rounds; round += 1) {
    for (let i = 0; i < variants.length; i += 1) {
      const idx = (round + i) % variants.length;
      samples[idx]!.push(timeVariant(cases, variants[idx]!.run));
    }
  }

  const toUsPerCall = (ms: number): number => (ms * 1000) / cases.length;
  console.log(`\n${title} — ${rounds} rounds x ${cases.length} searches (us/search):`);
  for (let i = 0; i < variants.length; i += 1) {
    const sample = samples[i]!;
    console.log(
      `  ${variants[i]!.name.padEnd(9)} median ${toUsPerCall(median(sample)).toFixed(2)}  ` +
        `[best ${toUsPerCall(Math.min(...sample)).toFixed(2)}, worst ${toUsPerCall(Math.max(...sample)).toFixed(2)}]`,
    );
  }
  const baselineSamples = samples[0]!;
  console.log('  Paired per-round ratios vs BASELINE:');
  for (let i = 1; i < variants.length; i += 1) {
    const ratios = baselineSamples.map((baseline, round) => baseline / samples[i]![round]!);
    const won = ratios.filter((ratio) => ratio > 1).length;
    console.log(
      `    ${variants[i]!.name.padEnd(9)} ${Math.min(...ratios).toFixed(3)}x WORST round  ` +
        `[median ${median(ratios).toFixed(3)}x, best ${Math.max(...ratios).toFixed(3)}x]  ` +
        `[rounds won ${won}/${ratios.length}]`,
    );
  }
}

async function main(): Promise<void> {
  const roundsRaw = Number(process.argv[2] ?? DEFAULT_ROUNDS);
  const rounds = Number.isInteger(roundsRaw) && roundsRaw > 0 ? roundsRaw : DEFAULT_ROUNDS;
  const [map1, map2] = await Promise.all([buildFloorOneMap(1), buildFloorOneMap(2)]);

  const reachable = [
    ...buildCases(map1, 0x5eed, SEARCHES_PER_MAP, 'seed1'),
    ...buildCases(map2, 0x5eee, SEARCHES_PER_MAP, 'seed2'),
  ];
  const unreachable = [
    ...buildUnreachableCases(map1, 0x5eef, 12, 'seed1'),
    ...buildUnreachableCases(map2, 0x5ef0, 12, 'seed2'),
  ];

  const variants: NamedVariant[] = [
    { name: 'BASELINE', run: computeGridPathBaseline },
    { name: 'CURRENT', run: computeGridPath },
  ];

  runPanel('reachable pairs on real Floor 1 maps', reachable, variants, rounds);
  runPanel('exhaustive (unreachable start) searches', unreachable, variants, rounds);

  const degenerate = reachable.slice(0, 8).map((c) => ({
    ...c,
    label: `${c.label}-degenerate`,
    goalX: c.startX,
    goalY: c.startY,
  }));
  const oracleCases = [...reachable, ...unreachable, ...degenerate];
  if (!checkEquivalence(oracleCases, variants.slice(1))) {
    console.error('❌ Post-timing oracle failed; disregard the timings above.');
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
