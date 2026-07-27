# Empty barrier overlay fast path

**Date:** 2026-07-27
**Apples:** 3🍎 estimated → 3🍎 actual
**Persona:** perf-optimizer

## Systems touched

mapgen, ai-behavior-tree

## What changed

`FloorMap.hasBarrierAtTile` / `hasBarrierAtPoint` now skip their installed lookup
closure entirely when the barrier registry's matching collection is empty.

The target was measured, not assumed. A real Floor-1 headless run (seed 1, to
completion) with `FloorMap.prototype` instrumented from outside:

```
isPassableAt calls:      15,476,669
hasBarrierAtTile calls:  19,371,656  -> returned TRUE 0  (0.0%)
hasBarrierAtPoint calls: 14,752,490  -> returned TRUE 0  (0.0%)
```

34.1M closure invocations, all false, because `attachBarriersToFloorMap` installs
both lookups unconditionally and Floor 1 never raises a barrier.

Note `hasBarrierAtTile` is called **more often than `isPassableAt`** — it has
callers beyond line-of-sight, `isTileTraversable` (pathfinding, flow-field) among
them. The win is wider than LOS alone.

## The shape shipped, and why not the other two

Three shapes were on the table:

| shape                                        | captures closure call? | staleness hazard         |
| -------------------------------------------- | ---------------------- | ------------------------ |
| (a) emptiness check _inside_ the closure     | ❌ still pays ~34M     | none                     |
| (b) cached boolean presence flag on FloorMap | ✅                     | **yes — gameplay bug**   |
| **(c) live-size gate — SHIPPED**             | ✅                     | **none by construction** |

(a) was rejected because the closure invocation _is_ the cost being removed.

(b) was rejected because a stale "no barriers here" flag means a barrier raised
mid-run silently stops blocking — and the Floor-1 `RunStats` fingerprint could
**never** catch it, because Floor 1 raises no barriers at all. A broken gate
produces a byte-identical fingerprint.

(c) `FloorMap` stores an optional, import-free **structural** reference to the
live barrier state and reads `Set.size` / `Map.size` **fresh on every call**.
There is deliberately **no flag, no version snapshot, and no invalidation** — the
gate reads the exact same ground truth that `isBarrierTile` / `isBarrierPointBlocked`
consult, so it cannot disagree with them. It is stale-proof by construction
rather than by bookkeeping discipline.

Design details that matter:

- The presence source is **`world`**, not `world.barriers`, because the closure
  body does `isBarrierTile(world, idx)` which reads `world.barriers` live, and
  `src/labs/ai-runner-lab/scenario-presets.ts:150` reassigns `world.barriers`
  wholesale. Passing `world` keeps gate and closure equally robust to that.
- Presence is an **optional defaulted 2nd parameter of the same setter call** as
  the lookup, so it can never be left attached to a lookup it does not describe.
  Every existing raw-lookup call site (e.g. `setBarrierLookup(() => true)` in
  `tests/unit/boss-spawn-placement.test.ts`) automatically clears it and keeps
  the old behaviour.
- **Two separate presence fields** (`barrierTilePresence`, `barrierPointPresence`)
  so neither setter can clobber the other's presence.
- `FloorMap`'s documented **zero import dependency** on the barrier module is
  preserved — `BarrierPresenceSource` is a structural type with no `import`.

## Evidence

### Neutrality — the load-bearing gate

`npm run perf:fingerprint --check` against a baseline recorded from a verified
clean tree: **24/24 runs byte-identical**, hash
`b311a7808b9e94cadd14d4733df332aee4560565f0a8fe3fb8528f3fe7c8e37e`
(FULL gate sample). Unlike the preceding hunt this gate is _not_ vacuous — there
is a real `src/` diff behind it.

### Benchmark — `scripts/agent/perf/bench-barrier-overlay.ts` (committed)

Same-process, interleaved, rotating lead, `WARMUP_SWEEPS = 4`, paired per-round
ratios, 15 rounds × 3 process invocations. Ratios are AFTER-vs-BEFORE, >1 means
AFTER is faster.

| panel                                        | median range     | worst single round | rounds won          |
| -------------------------------------------- | ---------------- | ------------------ | ------------------- |
| `hasClearLineOfSight` close approach (≤6 ft) | **1.171–1.180x** | 0.651x             | 13/15, 15/15, 14/15 |
| `hasClearLineOfSight` waypoint (≤48 ft)      | **1.190–1.275x** | 0.953x             | 15/15, 14/15, 15/15 |
| `isTileTraversable` tile probes (GROUND)     | **1.343–1.458x** | 0.714x             | 14/15, 13/15, 15/15 |

**13–15/15 rounds won in 9/9 panels across 3 invocations.** For contrast, the
allocation candidate this rig rejected last week scored 1–11/15 with every worst
round below 1.0.

Bench confounds explicitly avoided (all three cost the previous hunt real time):

- `FloorMapBefore` / `FloorMapAfter` are symmetric subclasses with **identical
  field sets** (BEFORE carries an unread `presence` field) and identical override
  sets — no hidden-class asymmetry.
- **Both** maps get the closures installed. Timing a wired map against a bare
  clone gives one side two live callbacks and the other a `barrierLookup === null`
  short-circuit; that confound flipped the prior session's result ~1.6x in _both_
  directions.
- Timed variants call the **genuinely shipped** `hasClearLineOfSight` /
  `isTileTraversable`, never a local copy that could drift. A `checkClosuresMatchProduction`
  drift guard verifies the hand-built closures against the ones
  `attachBarriersToFloorMap` installs, checked with a **NON-empty** registry so
  the shipped gate is inert during the check.
- The equivalence oracle and drift guard run **after** all timing — extra receiver
  shapes poison inline caches.

Equivalence is checked across three registry states (empty, 400 tile barriers
live, analytic ring wall live): 6000 segments + 6000 tile probes identical.

### Profile — did the shares actually move?

`npm run perf:profile --top 30`, n=2 samples each way (BEFORE taken by stashing
the `src/` diff, so both sides are the same machine and same session):

| function                    | BEFORE self% | AFTER self%  | verdict                                                |
| --------------------------- | ------------ | ------------ | ------------------------------------------------------ |
| `hasClearLineOfSight`       | 7.45%, 8.32% | 6.36%, 6.21% | **moved** (ranges do not overlap)                      |
| `isTileTraversable`         | 1.11%, 1.20% | 0.84%        | **moved**                                              |
| `computeFlowField`          | 6.12%, 6.49% | 5.89%, 5.53% | moved (it calls `isTileTraversable` in its inner loop) |
| `computeGridPath` (control) | 3.47%, 3.35% | 3.65%, 3.37% | **unchanged** ✅ control behaved                       |

`hasBarrierAtTile` / `hasBarrierAtPoint` never appear as their own profile rows —
V8 inlines them into their callers — so the parent rows are the only place the
win can show up, and they are where it showed up.

### Amdahl — derived honestly, `saving = share × (1 − 1/speedup)`

Using the **most conservative** figures available (lowest BEFORE share observed,
lowest median speedup observed):

```
hasClearLineOfSight:  7.45% × (1 − 1/1.171) = 7.45 × 0.1460 = 1.088%
isTileTraversable:    1.11% × (1 − 1/1.343) = 1.11 × 0.2554 = 0.284%
                                                    total  ≈ 1.37%
```

Cross-check against the observed profile deltas, again taking the most
conservative pairing (min BEFORE, max AFTER):
`(7.45 − 6.36) + (1.11 − 0.84) = 1.09 + 0.27 =` **1.36 pp**. The prediction and
the measurement agree to 0.01 pp.

Adjusting for the profiler's own startup dilution (11.4–12.6%, "true share ≈
displayed × 1.13") gives roughly **1.5%** in-game.

**Honest verdict: ~1.4–1.6% end-to-end, which is BELOW the ~3–5% end-to-end
noise floor.** This is _not_ claimed as a measured end-to-end win, and nobody
should quote it as one. What is measured and reproducible is (i) the per-function
speedup — 13–15/15 rounds won in 9/9 panels over 3 process invocations — and
(ii) the profile share drop, with non-overlapping BEFORE/AFTER ranges and an
unchanged control row. The change stands on being a zero-risk deletion of 34.1M
provably-useless calls per run, not on a headline end-to-end number.

The derivation also **under**-counts: `isPassableAt` has callers beyond LOS and
pathfinding (movement, collision) that were not modelled, and `computeFlowField`
moved too. It **over**-counts in one respect: the bench's synthetic segment mix
is not the production-weighted mix.

## Correctness — the mutation-proven regression test

`tests/unit/barriers/empty-overlay-fast-path.test.ts` (12 tests) is the
load-bearing gate, because the fingerprint structurally cannot catch a broken
fast path. Every test raises a **real** barrier through the real registry
mutators **after** wiring is attached (the mid-run case) and asserts it blocks.
The tile and point halves are exercised **independently**, with the other
collection empty, so a crossed-wire implementation fails even though a
both-barriers-live test would pass.

Four deliberate mutations were run and each confirmed red:

| mutation                                                               | simulates                | result                                                                 |
| ---------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| **M1** gate always fires (`if (presence !== null) return false`)       | a stale "empty" flag     | **10 red** (6 in this file, 2 registry, 2 physics)                     |
| **M2** crossed wires (tile gated on `ringShapes.size`, and vice versa) | copy-paste error         | **7 red** (4 in this file)                                             |
| **M3** fast path removed entirely                                      | optimization lost        | **1 red** — correctly _only_ the skip assertion, not a correctness one |
| **M4** `world` presence args dropped from `attachBarriersToFloorMap`   | wiring silently unhooked | **2 red**                                                              |

M4 was added in response to a code-review finding: the original tests re-installed
spy lookups _through_ the wiring contract, so they proved `FloorMap`'s gate worked
but would still have passed if `attachBarriersToFloorMap` stopped passing `world`
and the whole optimization silently vanished. The new
`attachBarriersToFloorMap installs the presence source` block closes that by
observing the closures **production actually installed**, via `Proxy` handlers
that count member access: the gate reads `blockedTiles.size` but only the closure
calls `blockedTiles.has`, so gate-active means a `has` count of 0.

Running M4 also exposed that a first attempt at a point-half empty-registry
assertion was **vacuous** — with an empty registry the gate-present path does one
`ringShapes.size` read and skips the closure, while the gate-absent path runs the
closure whose own `size === 0` check does exactly one read. Identical counts, so
the assertion could never fail. It was **deleted rather than kept**; the point
half's skip is covered behaviourally by the `vi.fn` spy test, and the gate's
presence is proven by the barrier-live case (2 reads vs 1).

## Review

- Plan review (gpt-5.6-sol, red-teamed to argue for (a)/(b) over (c)): SHIP WITH
  CHANGES, 3 concerns, all resolved. Upheld shape (c).
- Code review round 1 (gpt-5.6-sol): 1 finding — the wiring change was untested.
  Fixed (M4 above).
- Code review round 2 (gemini-3.1-pro-preview): clean.

Ledger: `docs/knowledge/review-ledgers/2026-07-27-empty-barrier-overlay-fast-path.review-ledger.json`

## Things that bit me

1. **A test can be green for the wrong reason even when the mutation proof
   passes.** M1/M2/M3 all went red, which felt like proof. It wasn't — none of
   them mutated `wiring.ts`, so the wiring half was entirely uncovered and a
   reviewer had to find it. **Mutate every file in the diff, not just the one
   that feels load-bearing.**
2. **Deriving a discriminating assertion is not the same as having one.** I
   reasoned that the point-half empty case would read `ringShapes.size` once with
   the gate and twice without. It's once either way. The only reason I found out
   is that I ran the mutation and watched which tests actually failed. **Always
   confirm _which_ tests go red, never just that the count is non-zero.**
3. **The barrier lookups do not appear in the profile under their own names.**
   V8 inlines them into `isPassableAt` / `isTileTraversable`, so a
   "did the target's share move?" check has to be aimed at the _parent_ rows
   chosen in advance. Deciding that afterwards would have been unfalsifiable.
4. **Take a second BEFORE profile.** The first BEFORE/AFTER pair matched the
   Amdahl prediction to 0.01 pp, which was almost too good. A second sample each
   way is what turned "suspiciously clean single pair" into non-overlapping
   ranges, and a control row (`computeGridPath`) is what showed the shift wasn't
   a global rescale.
