/**
 * Grid A* — a project-owned, allocation-free replacement for rot-js's
 * `Path.AStar` on a 4-connected integer tile grid.
 *
 * ## Why this exists
 *
 * `Path.AStar.compute` was the single most expensive function in a headless
 * Floor-1 run (`npm run perf:profile`: ~16% self / ~19% total), and 100% of
 * that cost is driven by {@link findTilePath}. rot-js's implementation carries
 * five structural costs that have nothing to do with the search itself:
 *
 * 1. the open list is a **sorted plain array**, inserted into with an O(n)
 *    linear scan plus `Array.splice` (a memmove per push) — O(n²) overall;
 * 2. it is popped with `Array.shift()` — O(n) per pop;
 * 3. the closed set is a plain object keyed by the **string** `` `${x},${y}` ``,
 *    so every pop and every neighbour test allocates a string and hits a
 *    dictionary-mode object;
 * 4. `_getNeighbors` allocates a fresh array-of-arrays per expansion;
 * 5. every push allocates an `{x, y, prev, g, h}` object, and pushes are not
 *    deduplicated.
 *
 * This module keeps the *algorithm* byte-for-byte identical and replaces only
 * the data structures: a binary min-heap open list and generation-stamped
 * typed arrays indexed `y * width + x`.
 *
 * ## Exact-ordering contract (do not "improve" any of this)
 *
 * `findTilePath` feeds AI movement, so **any** change in tie-breaking changes
 * gameplay. This implementation reproduces rot-js 2.2.1 exactly:
 *
 * - The search runs **backwards**: it is seeded at the **goal** and terminates
 *   when the **start** is popped. `h` is the Manhattan distance to the
 *   **start**. The emitted path therefore runs start → … → goal.
 * - `g = prev.g + 1` (unweighted), `f = g + h`.
 * - Open-list order is **`(f asc, h asc, insertion-sequence asc)`**. rot-js
 *   inserts before the first element it strictly beats, so it lands *after*
 *   everything it ties with — a stable/FIFO priority queue. A plain binary
 *   heap is **not** stable, so the monotonic entry id is carried as the final
 *   tiebreak.
 * - **Duplicate open-list entries are preserved.** rot-js has no decrease-key;
 *   a tile may be pushed many times and is deduplicated at *pop* time. Turning
 *   this into a decrease-key would change which duplicate wins and therefore
 *   the resulting path. The one exception is the *provably inert* subset
 *   described under "Dominated-duplicate filter" below, which is dropped
 *   because it can only ever be popped as a no-op.
 * - The closed set is **first-write-wins** at pop time.
 * - Neighbours are visited in `DIRS[4]` order — **N, E, S, W** — which feeds
 *   the insertion sequence and so is load-bearing for tie-breaking.
 * - The passability predicate is called **exactly once per neighbour per
 *   expansion, for all four directions, in N/E/S/W order, before any of them
 *   is enqueued** — including for out-of-bounds and already-closed tiles.
 *   rot-js builds its whole neighbour list before testing the closed set, and
 *   `PathfindingOptions.isTilePassable` is a caller-supplied function with no
 *   enforced purity, so skipping "redundant" probes would be observable to a
 *   stateful predicate. The redundant calls are kept deliberately.
 *
 * ## Dominated-duplicate filter (open-list only — provably inert)
 *
 * A Floor-1 headless panel (seeds 1-3 x sword) pushes **10.41 M** open-list
 * entries and pops **9.96 M**, of which **4.14 M (41.6%)** are stale pops that
 * do nothing but `continue`. **2.78 M (26.7%)** of those pushes are *dominated*:
 * at push time the same tile already has an open entry that is ordered strictly
 * earlier under `(f asc, h asc, entryId asc)`.
 *
 * {@link GridAStarScratch.push} drops exactly that subset. It is inert, not a
 * heuristic:
 *
 * 1. Let `e_best` be the recorded open entry for tile `t` and `e_new` the push
 *    being considered, with `f(e_best) <= f(e_new)`. Within a search `h` is a
 *    pure function of the tile, so both entries share the same `h` and equal
 *    `f` means an exact `(f, h)` tie. `e_best` was pushed earlier, so its entry
 *    id is smaller and it is ordered strictly before `e_new` under the full
 *    three-key order.
 * 2. `e_best` is still on the heap. Any pop of *any* entry for `t` leaves
 *    `stamp[t] === generation`, and the expansion loop already refuses to push
 *    onto a tile with that stamp — so reaching a push for `t` proves nothing
 *    for `t` has been popped yet.
 * 3. Therefore `e_new` can only ever be popped **after** `e_best`, by which
 *    time `stamp[t] === generation` and the pop body is a bare `continue`.
 *    Either the search terminates first (and `e_new` is never observed), or
 *    `e_new` pops as a no-op. Neither reaches `prevTile`, the visitor, or
 *    `isPassable`.
 * 4. Dropping a push shifts every later entry id down by one *uniformly*, so
 *    the relative id order — the only way ids are ever compared — is preserved.
 *
 * The filter therefore changes neither the popped-and-expanded sequence, the
 * closed set, `prevTile`, the emitted path, nor the ordered `isPassable` probe
 * trace. It only removes heap work. `scripts/agent/perf/bench-astar-dominance.ts`
 * measures the win and proves the equality differentially against a verbatim
 * pre-change baseline.
 *
 * Because the filter is *inert by construction*, any edit that merely makes it
 * prune LESS is output-identical and therefore cannot be caught by a
 * correctness test — only by the open-list size. That is what
 * {@link __getGridAStarLastEntryCountForTests} exists to pin. Edits that make
 * it prune MORE are genuine gameplay changes and are caught by
 * `tests/ecs/astar-grid-equivalence.test.ts`.
 *
 * ## Allocation strategy
 *
 * The search itself performs **no steady-state allocation**: scratch is reused
 * across calls and only reallocated when the map's tile count changes or the
 * open list outgrows its capacity. (The caller still allocates its own result;
 * this module allocates none of it.)
 *
 * Per hunting-grounds A3 the mechanism here is **(2) encapsulated
 * non-escaping**: all scratch lives in module-level {@link GridAStarScratch}
 * objects that are never returned, stored on a caller-visible object, or
 * captured by anything the caller can reach. The only thing that leaves this
 * module is `(x, y)` number pairs handed to the visitor callback.
 *
 * Reentrancy is handled by a **depth-indexed pool** rather than a throwing
 * guard: if a passability predicate ever re-entered {@link computeGridPath},
 * the nested call takes the next scratch slot down, so it is merely slower —
 * never corrupt. The slot is released in a `finally`, so a predicate or visitor
 * that throws cannot leak depth.
 */

/** Predicate deciding whether the search may step onto a tile. */
export type GridPassableFn = (x: number, y: number) => boolean;

/** Called once per path tile, in start → goal order. */
export type GridPathVisitor = (x: number, y: number) => void;

/** Neighbour offsets in rot-js `DIRS[4]` order: N, E, S, W. */
const DIR_X = [0, 1, 0, -1] as const;
const DIR_Y = [-1, 0, 1, 0] as const;

/** Initial capacity of the open-list entry arrays; grows by doubling. */
const INITIAL_ENTRY_CAPACITY = 256;

/**
 * Highest generation stamp before the closed-set array must be zeroed. Int32
 * arrays saturate at 2^31-1, so wrapping is handled explicitly rather than
 * silently aliasing an old search's stamps.
 */
const MAX_GENERATION = 0x7fffffff;

/**
 * Per-search scratch state. Sized to the map on demand and reused across
 * calls; nothing here is ever handed to a caller.
 */
class GridAStarScratch {
  /** Tile count the per-tile arrays are currently sized for. */
  tileCount = 0;
  /** Generation stamp per tile; `stamp[t] === generation` means "closed". */
  stamp = new Int32Array(0);
  /** Tile index this tile was closed from, or -1 for the goal seed. */
  prevTile = new Int32Array(0);
  /**
   * Dominance filter, part 1: generation stamp marking "at least one entry has
   * been pushed for this tile during the current search". It is never cleared
   * when an entry is popped, which is safe precisely because a closed tile can
   * never be pushed again (the expansion loop checks {@link stamp} first).
   * Separate from {@link stamp}, which marks *closed*.
   */
  openStamp = new Int32Array(0);
  /**
   * Dominance filter, part 2: the lowest `f` among open entries for the tile.
   * Valid only while `openStamp[tile] === generation`.
   *
   * `h` needs no companion array: within one search `h` is
   * `|x - startX| + |y - startY|`, a pure function of the tile, so every entry
   * for a given tile carries the same `h` and ordering by `f` alone is
   * identical to ordering by `(f asc, h asc)`.
   */
  bestF = new Int32Array(0);
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
    this.openStamp = new Int32Array(tileCount);
    this.bestF = new Int32Array(tileCount);
    this.tileCount = tileCount;
    // Fresh arrays are all-zero, so the next generation must not be 0.
    this.generation = 0;
  }

  /** Start a new search: bump the generation, reset the open list. */
  beginSearch(): void {
    if (this.generation >= MAX_GENERATION) {
      this.stamp.fill(0);
      // Both stamp arrays are generation-keyed, so both must be cleared on a
      // wrap or a stale `openStamp` would alias generation 1 and suppress a
      // legitimate push.
      this.openStamp.fill(0);
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
   *
   * Dominated pushes are dropped before they reach the heap: if this tile
   * already has an open entry whose `f` is less than or equal to this one's,
   * that entry is ordered strictly earlier — equal `f` implies equal `h` (see
   * {@link bestF}), and it also has a smaller id — so it closes the tile first
   * and this entry could only ever pop as a bare `continue`. See
   * "Dominated-duplicate filter" in the module header for the full argument; it
   * is an exact identity, not a heuristic.
   */
  push(tile: number, g: number, h: number, prev: number): void {
    const f = g + h;
    const generation = this.generation;
    if (this.openStamp[tile] === generation) {
      if (this.bestF[tile]! <= f) return;
    } else {
      this.openStamp[tile] = generation;
    }
    this.bestF[tile] = f;

    if (this.entryCount >= this.entryTile.length) this.growEntries();
    const e = this.entryCount++;
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
const scratchPool: GridAStarScratch[] = [];
let scratchDepth = 0;

function acquireScratch(): GridAStarScratch {
  let scratch = scratchPool[scratchDepth];
  if (scratch === undefined) {
    scratch = new GridAStarScratch();
    scratchPool[scratchDepth] = scratch;
  }
  scratchDepth += 1;
  return scratch;
}

function releaseScratch(): void {
  scratchDepth -= 1;
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
export function computeGridPath(
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

  const scratch = acquireScratch();
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
        const nx = x + DIR_X[d]!;
        const ny = y + DIR_Y[d]!;
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
    releaseScratch();
  }
}

/**
 * Test-only hook: number of open-list entries the most recent search actually
 * pushed (`scratch.entryCount` is left in place after a search completes, so
 * this costs nothing in the hot path).
 *
 * This is the **only** observable that the dominated-duplicate filter is live.
 * The filter is output-identical by construction, so a regression that disabled
 * it would leave every correctness assertion green and only make the game
 * slower. Returns 0 when no search has run since the last reset.
 */
export function __getGridAStarLastEntryCountForTests(): number {
  return scratchPool[0]?.entryCount ?? 0;
}

/**
 * Test-only hook: force the depth-0 scratch generation counter, so the
 * `MAX_GENERATION` wrap in {@link GridAStarScratch.beginSearch} can be reached
 * in a test instead of after 2^31 searches.
 *
 * Without this the wrap is unreachable in practice and therefore untested — and
 * it is load-bearing: both {@link GridAStarScratch.stamp} and
 * {@link GridAStarScratch.openStamp} are generation-keyed, so a wrap that
 * cleared only one of them would let a previous search's stamps alias
 * generation 1 and silently corrupt the next search.
 *
 * Note that this hook and {@link __getGridAStarLastEntryCountForTests} are
 * introspection for tests only. They are not part of the observable contract
 * this module promises to callers — that contract is the emitted path, the
 * ordered `isPassable` probe trace, and nothing else.
 */
export function __forceGridAStarGenerationForTests(generation: number): void {
  const scratch = scratchPool[0];
  if (scratch !== undefined) scratch.generation = generation;
}

/**
 * Test-only hook: drop every pooled scratch buffer.
 *
 * Exists so equivalence tests can prove the implementation is correct from a
 * cold start as well as a warm one (generation stamps and grown arrays are the
 * two pieces of state that persist between calls).
 */
export function __resetGridAStarScratchForTests(): void {
  scratchPool.length = 0;
  scratchDepth = 0;
}

/**
 * Test-only hook: current scratch-pool depth, which must be 0 whenever no
 * search is running.
 *
 * Without this, a test that only re-checks path correctness after a throwing
 * predicate is **vacuous** with respect to the `finally` release: a leaked depth
 * level merely makes the next search allocate a fresh, correctly-sized slot, so
 * it still returns the right path. Asserting the depth is what actually pins the
 * release.
 */
export function __getGridAStarScratchDepthForTests(): number {
  return scratchDepth;
}

/**
 * Test-only hook: number of distinct pooled scratch objects.
 *
 * The depth counter alone does **not** prove reentrancy isolation — a broken
 * pool that always handed back slot 0 would still increment and decrement the
 * depth. Only the pool size distinguishes "took a second slot" from "reused the
 * first one".
 */
export function __getGridAStarScratchPoolSizeForTests(): number {
  return scratchPool.length;
}
