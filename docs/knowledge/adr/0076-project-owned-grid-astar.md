# ADR 0076: Project-owned grid A\* replaces rot-js `Path.AStar` in `findTilePath`

## Status

Accepted

## Date

2026-07-26

## Estimated Complexity

🍎 x 5 — two systems (mapgen, ai-behavior-tree), strict byte-identical compatibility
contract, multi-round adversarial review required

## Context

`findTilePath` is the only consumer of `Path.AStar` from rot-js, and it accounted for
**16.16% self / 19.02% total** CPU time in a headless Floor-1 simulation profile.
The bottleneck was entirely inside rot-js's data structures, not the A\* algorithm itself:

- Open list: sorted `Array` with O(n) linear scan on every push (`splice`) and O(n)
  pop (`Array.shift()`).
- Closed set: plain object keyed `` `${x},${y}` `` — string-key hash + heap allocation
  per pop.
- Neighbor allocation: `_getNeighbors` allocates a fresh `[[x,y],…]` array on every
  node expansion.
- One `{x,y,prev,g,h}` object allocation per open-list push.

Because `findTilePath` results drive AI movement, any change to tie-break ordering or
path content is a gameplay change that fails the fingerprint neutrality gate. This
creates an unusual requirement: the replacement must be **byte-identical** in every
path it returns, not merely correct per the A\* specification.

## Decision

Replace rot-js's `Path.AStar` for integer tile coordinates with a project-owned
implementation (`src/core/map/astar-grid.ts`) that keeps the **algorithm byte-for-byte
identical** and replaces only the data structures:

| rot-js 2.2.1                                        | grid A\*                                             |
| --------------------------------------------------- | ---------------------------------------------------- |
| sorted `Array` + O(n) scan + `splice` open list     | binary min-heap over `(f, h, entryId)`               |
| `Array.shift()` pop — O(n)                          | heap pop — O(log n)                                  |
| plain object keyed `` `${x},${y}` `` as closed set  | generation-stamped `Int32Array` indexed `y*width+x`  |
| `_getNeighbors` allocates `[[x,y],…]` per expansion | four probes into a reused `Uint8Array(4)`            |
| one `{x,y,prev,g,h}` object per push                | five parallel `Int32Array`s indexed by insertion seq |

The implementation reproduces rot-js's ordering contract exactly:

- Search runs **backwards** (seeded at goal, terminates when start pops); `h` =
  Manhattan distance to start.
- Open-list order is `(f asc, h asc, insertion-sequence asc)` — rot-js's `splice`
  inserts before the first element it strictly beats, which is a stable/FIFO queue.
  A plain binary heap is not stable, so the monotonic entry id is the final tiebreak.
- **Duplicates are preserved** (no decrease-key); deduplication happens at pop time,
  closed set is first-write-wins.
- Neighbours are probed **N, E, S, W**, and the passability predicate is called for
  **all four** directions before any closed-set check — including for out-of-bounds
  and already-closed tiles. `isTilePassable` is caller-supplied and not required to be
  pure; redundant probes are load-bearing and kept deliberately.

Non-integer coordinates fall back to `Path.AStar` unchanged, so rot-js remains a
dependency. Scratch is managed via a module-level depth-indexed pool (reentrant,
`try/finally` release), giving zero per-call allocation after warm-up.

Byte-identical correctness is enforced by:

1. `tests/ecs/astar-grid-equivalence.test.ts` — 32 tests comparing paths **and**
   passability-probe traces against a live rot-js instance.
2. `scripts/agent/perf/bench-pathfinding.ts` — 4,350 element-by-element comparisons.
3. `npm run perf:fingerprint -- --check` — 24 headless Floor-1 runs, byte-identical
   `RunStats` before and after.

## Consequences

### Positive

- **~7–8x per-call speedup** (median 7.45–8.11x across three process invocations,
  worst round 4.58x, 27/27 rounds won), reducing headless-sim CPU by ≈14% (≈1.16x
  end-to-end).
- Zero steady-state allocation per search after warm-up (encapsulated non-escaping
  scratch pool).
- The replacement is fully tested, mutation-proved non-vacuous, and has an
  independent headless fingerprint gate.
- The byte-identical contract is mechanically enforced — any future change that alters
  path ordering will immediately fail the equivalence suite and the fingerprint gate.

### Negative

- The project now owns a bespoke A\* implementation. Future changes to the algorithm
  (e.g. weighted edges, jump-point search) must be made here rather than picking up an
  upstream fix.
- The exact-compatibility contract (all four probes before any closed-set check,
  FIFO stability, no decrease-key) is non-obvious and must be preserved by future
  editors. It is documented both in `astar-grid.ts` and in this ADR.
- Non-integer-coordinate paths still use rot-js, so there are now two A\* code paths
  that must stay in sync if the passability semantics change.

### Risks

- If the ordering contract is silently broken by a future edit, the fingerprint gate
  will catch it — but only on the 24-run sample. More exotic tie-break patterns could
  slip through.
- The scratch pool is reentrant but has a fixed depth cap; a pathological recursion
  that exceeds that cap will throw rather than silently corrupt.

## Alternatives Considered

1. **Swap only the closed set (string `_done` → typed array), keep rot-js's open list.**
   Measured by the `CLOSEDSET` bench variant (a multi-change ablation: it also removes
   the `_getNeighbors` array allocation). This reaches ~5.2–5.8x, leaving roughly
   a third of the total win on the table. Rejected as insufficient.

2. **Keep rot-js; profile and tune the call sites (fewer searches, shorter
   `maxPathLength` caps, result caching).**
   Valid for reducing call count, but does not reduce per-call cost. The profiler shows
   the cost is entirely inside the data structures, not in the number of searches.
   Caller-side tuning is orthogonal and can still be applied on top of this change.
   Rejected as primary strategy because it leaves the per-call regression intact.

3. **Replace rot-js entirely with a maintained pathfinding library that uses better
   data structures.**
   The byte-identical requirement rules out any library that does not reproduce rot-js's
   exact tie-breaking. No known library provides that guarantee. Rejected: the custom
   implementation is the only way to satisfy the compatibility constraint.

4. **Relax the byte-identical requirement; accept path variation.**
   `findTilePath` feeds AI movement; path changes are gameplay changes that affect
   every downstream simulation invariant. Accepting variation would invalidate the
   fingerprint gate and require re-baselining all headless reference data. Rejected:
   the constraint exists for correctness, not convenience.
