# Grid A\* replaces rot-js `Path.AStar` in `findTilePath`

**Date:** 2026-07-26
**Session slug:** `astar-grid-pathfinding`
**Apples:** 5🍎 estimated / 5🍎 actual
**PR:** see branch `nalfeo-crispy-waddle`

## Systems touched

mapgen, ai-behavior-tree

## What changed

`findTilePath` (`src/core/map/pathfinding.ts`) no longer calls rot-js's
`Path.AStar` for integer tile coordinates. It calls `computeGridPath` from the
new `src/core/map/astar-grid.ts`, which keeps the **algorithm byte-for-byte
identical** and replaces only the data structures:

| rot-js 2.2.1                                    | grid A\*                                              |
| ----------------------------------------------- | ----------------------------------------------------- |
| open list = sorted `Array` + O(n) scan + `splice` | binary min-heap over `(f, h, entryId)`                |
| pop = `Array.shift()` (O(n))                     | heap pop (O(log n))                                   |
| closed set = plain object keyed `` `${x},${y}` `` | generation-stamped `Int32Array` indexed `y*width + x` |
| `_getNeighbors` allocates `[[x,y],…]` per expansion | four probes into a reused `Uint8Array(4)`          |
| one `{x,y,prev,g,h}` object per push             | five parallel `Int32Array`s, index == insertion seq   |

Scratch is reused across calls (hunting-grounds **A3 mechanism (2): encapsulated
non-escaping**) via a module-level depth-indexed pool, so a search does **no
steady-state allocation**. Reentrancy takes the next pool slot down; a
`try/finally` releases it even when a caller-supplied predicate or visitor throws.

## Results

**Per-call speedup (the honest headline).** `scripts/agent/perf/bench-pathfinding.ts`
runs all variants **in one process, interleaved, alternating which leads each
round**, and reports **paired per-round ratios** (a machine-wide stall inflates
every variant together, so paired ratios survive it).

A round-2 review caught the first version of this bench reporting medians of
**4.71x, 8.13x and 8.42x for identical code** across three process invocations —
one untimed warmup sweep left V8 still tiering during the early timed rounds. The
bench now does **4 rotated warmup sweeps**, and the numbers below are the range
across **three separate process invocations**, not one run:

| fixture (real Floor-1, 240×140) | median across 3 runs | **worst single round** | rounds won |
| ------------------------------- | -------------------- | ---------------------- | ---------- |
| reachable searches (300/round)  | **7.45 – 8.11x**     | **4.58x**              | 27/27      |
| unreachable/sealed (40/round)   | **6.82 – 7.38x**     | **5.24x**              | 27/27      |

**Report the worst round, not the best: this change is worth ≥4.6x per call, and
about 7–8x typically.**

**Profile share** (`npm run perf:profile`, 3 headless Floor-1 runs):

| | before | after |
| --- | --- | --- |
| A\* search machinery | `rot.js:5356 compute` — **16.16% self / 19.02% total** | `computeGridPath` — **2.55% self / 4.80% total** |

**Honest end-to-end: ≈14% less headless-sim CPU (≈1.16x).** Normalising on the
unchanged work (`1 − 0.1616` before vs `1 − 0.0255` after) puts the in-situ
speedup of the search machinery at **≈7.4x**, which lands inside the bench's
7.45–8.11x median range — two independent measurements agreeing. The end-to-end
figure is capped by Amdahl: the subsystem was 19% of the sim, so even an
infinitely fast A\* could not have returned more than ~19%.

**Ablation.** A `CLOSEDSET` bench variant (rot-js's open list kept verbatim, only
the string-keyed closed set replaced) reaches **5.2 – 5.8x**. So the string-keyed
`_done` object was the dominant cost and the heap contributes a further ~1.4x on
top. That measurement retired the plan-review's "just swap the closed set"
alternative — it would have left roughly a third of the win on the table.

## Byte-identical gameplay — the hard gate

`findTilePath` decides AI movement, so any tie-break change is a gameplay change.

- **`npm run perf:fingerprint -- --check files/perf-baseline.json`: PASS.**
  `RunStats identical: every run in the sample matches the baseline
  byte-for-byte.` — 24 runs, FULL gate sample, hash
  `b311a7808b9e94cadd14d4733df332aee4560565f0a8fe3fb8528f3fe7c8e37e`. The
  baseline was written from **unmodified** code before any edit landed.
- Differential oracle: **4,350 comparisons byte-identical**, over 30 random maps
  × 25 pairs + enumerated edge cases (same tile, adjacent, OOB, flying, sealed,
  `maxPathLength` ∈ {1,2,3,5,8,4096}) and a real Floor-1 map (300 reachable + 40
  sealed pairs). Compared element-by-element, never hashed.
- `tests/ecs/astar-grid-equivalence.test.ts` (32 tests) diffs against a **real
  rot-js instance**, on both the returned path **and the ordered
  passability-probe trace**.

### The ordering contract (do not "improve" any of this)

Recorded at the top of `astar-grid.ts`; repeated here because it is the whole
reason this change is safe:

- Search runs **backwards** — seeded at the **goal**, terminates when the
  **start** is popped; `h` is Manhattan distance to the **start**.
- Open-list order is `(f asc, h asc, insertion-sequence asc)`. rot-js splices in
  before the first element it strictly beats, so it lands **after** everything it
  ties with — a **stable/FIFO** priority queue. A plain binary heap is **not**
  stable, so the monotonic entry id is carried as the final tiebreak (the sift-up
  breaks on an exact `(f, h)` tie because a new entry always has the largest id).
- **Duplicates in the open list are preserved** — rot-js has no decrease-key;
  dedupe happens at pop time. Turning this into a decrease-key changes the path.
- Closed set is **first-write-wins** at pop time.
- Neighbours are probed **N, E, S, W**, and the predicate is called for **all
  four** directions **before** any closed-set check — including for
  out-of-bounds and already-closed tiles. `PathfindingOptions.isTilePassable` is
  caller-supplied and not required to be pure, so those redundant probes are
  load-bearing and kept deliberately. A `PRUNED` bench variant that skips them
  reaches 10.18x; that ~1.2x gap is the **price of exactness** and was not taken.

### Non-integer coordinates keep the rot-js path

`TileMap.inBounds` accepts fractional coordinates, so a permissive
`isTilePassable` override (or FLYING traversal) can legitimately search a
fractional lattice that no tile-indexed grid can represent. `findTilePath` routes
any non-integer endpoint to the original `Path.AStar`, unchanged. `rot-js` is
therefore still a dependency.

## Observe before done

The real artifact is the **headless Floor-1 pipeline** (`npm run perf:fingerprint`
drives `src/game/ai/headless-runner.ts` — not a lab): 24 real runs across seeds
1–8 × sword/bow/baseball-bat produced byte-identical `RunStats` before and after,
and `npm run perf:profile` on that same pipeline shows the frame moving from
16.16% self to 2.55% self.

## Regression tests are non-vacuous (proved by mutation)

Each of these mutations was applied and the suite re-run:

| mutation | result |
| --- | --- |
| break FIFO stability (sift-up ignores the exact `(f, h)` tie) | **10 failed** |
| reverse neighbour order to W, S, E, N | **12 failed** |
| prune the redundant OOB/closed passability probes | **12 failed** |
| drop the `try/finally` scratch release | **2 failed** |
| make the pool always hand back slot 0 (no reentrancy isolation) | **runaway → OOM** |

The last two exist because the multi-model review found the original pool tests
**vacuous**, twice over:

1. A throwing predicate that leaked pool depth still passed, because the next
   search just allocated a fresh, correctly-sized slot and returned the right
   path. `__getGridAStarScratchDepthForTests()` was added so the assertion pins
   the `finally` itself.
2. The first depth fix was *still* vacuous for reentrancy: a pool that always
   handed back slot 0 would increment and decrement the same counter, so
   `depth === 2` proved nothing. Verified by applying that mutation and watching
   the suite pass. The fix is `__getGridAStarScratchPoolSizeForTests()` plus a
   longer outer map so the nested call fires while the outer open list is still
   live — with a shared slot the outer search now never terminates.

Both were found by **applying the mutation and watching the test pass**, not by
assuming it would fail.

## Gotchas for the next session

- `npm run perf:fingerprint` writes/checks against a path — a bare `--check`
  errors. Write the baseline from a **clean tree**; a mid-run edit contaminates it
  (this session restarted the baseline once for exactly that reason).
- Cross-process benchmarking already produced one bogus 4.5x claim in this repo.
  `bench-pathfinding.ts` follows `bench-fov.ts`: same process, interleaved,
  alternating lead, **paired** per-round ratios. But same-process is not enough on
  its own — **one untimed warmup sweep left V8 mid-tiering and swung the median
  between 4.7x and 8.4x for identical code.** Warm up several rotated sweeps, run
  the whole script more than once, and publish a range plus the worst round.
- A microbench assertion about a resource *counter* can be vacuous even when the
  resource is broken. Assert on the thing that actually differs (here: pool size,
  not depth), and always confirm by applying the mutation.
- `Int32Array` fields need `Int32Array<ArrayBuffer>` on helper signatures under
  this tsconfig, or TS2322 fires on `SharedArrayBuffer` variance.
- Review agents can leave stray files at the repo root (`test-vitest.test.ts`,
  `diff.txt` here); `verify:fast` rejects TS outside the supported trees, which is
  how they were caught.

## Next target

With A\* down to 4.80% total, the profile's new leaders are
`hasClearLineOfSight` (5.47% self, `src/game/ai/bt-ai-geometry.ts`),
`computeFlowField` (3.75% self, `src/core/map/flow-field.ts`) and
`planObjectiveRoute` (3.52% self / 8.85% total). `planObjectiveRoute` is the
largest remaining subsystem and is a `findTilePath` caller, so the next win there
is likely algorithmic (fewer searches) rather than a faster search.
