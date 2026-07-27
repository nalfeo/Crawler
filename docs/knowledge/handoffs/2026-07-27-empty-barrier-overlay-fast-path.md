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
There is deliberately **no flag, no version snapshot, and no invalidation**.

The correctness argument is stronger than "it reads the same ground truth" — the
two gates **cannot** disagree with the predicates they guard, by definition:

- `isBarrierTile` is _literally_ `world.barriers.blockedTiles.has(tileIdx)` and
  nothing else (`registry.ts:98-99`). So `blockedTiles.size === 0 ⇒ false for
every tile` is a **provable entailment of the predicate's definition**, not a
  heuristic that happens to hold today.
- `isBarrierPointBlocked` **already performs** `if (ringShapes.size === 0) return false`
  as its own first statement (`registry.ts:124`). The point gate is a pure
  **hoist of the callee's own check** up one stack frame — the identical test,
  moved.

That is the difference between "we believe it agrees" and "it cannot disagree",
and it is why this ships with no bookkeeping discipline required anywhere.

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

### Neutrality — trivially green, and NOT a correctness gate

`npm run perf:fingerprint --check` against a baseline recorded from a verified
clean tree: **24/24 runs byte-identical**, hash
`b311a7808b9e94cadd14d4733df332aee4560565f0a8fe3fb8528f3fe7c8e37e`
(FULL gate sample).

⚠️ **This gate is nearly tautological for this change, and is NOT the
correctness gate.** Floor 1 raises zero barriers, so the fast path always fires
and the old code always returned false — the two are trivially identical on this
fixture. A completely broken fast path that wrongly answered "empty" produces
the _same_ byte-identical hash. This is the `spawnerSystem` shape in AGENTS.md
r9. State both halves precisely:

- **What it covers:** unintended collateral perturbation — the diff did not
  change Floor-1 simulation in any other way. Real, and worth having.
- **What it structurally cannot cover:** the only hazard this change actually
  has, a stale or wrong emptiness verdict. Do not read 24/24 as covering
  staleness; it cannot touch it.

The real gates are the analytical entailment above and the mutation-proven suite
below. Both are stronger evidence than the fingerprint. The parent session
deliberately declined to re-run the fingerprint during audit for exactly this
reason — it would have been ritual, not evidence.

### Why a live read, and not a version-stamped cache or a boolean flag

The invalidation surface was enumerated rather than assumed. Into
`blockedTiles` / `ringShapes` there are:

- **2 writers** — `registerHandle` (`registry.ts:53,56`) and `dropBarrier`
  (`registry.ts:85,89`). Both bump `version`.
- **5 public entry points** — `createRingBarrier`, `createRingWallBarrier`,
  `createRoomBarrier`, `createPolyBarrier` (all funnel into `registerHandle`),
  plus `dropBarrier`.
- **1 path that bypasses `version` entirely** — wholesale `world.barriers`
  reassignment (`src/labs/ai-runner-lab/scenario-presets.ts:150`).

That last one is decisive. A fresh registry starts at `version: 0`, so a
version-stamped cache holding stamp `0` against a _reassigned_ registry also at
`0` compares equal and **goes stale silently** — the exact failure mode a
version stamp exists to prevent. A boolean flag is worse again: a missed
mutation path fails as a permanently-false flag, indistinguishable from "no
barriers exist".

The shipped gate has **no cache at all**. It reads the same object the closure
is about to consult, so there is no invalidation surface to get wrong and none
of the 6 paths above needs to know the gate exists. Strictly stronger than a
version stamp, not an alternative to it.

**Why not "don't install a lookup that can never fire":** considered, rejected.
Whether a lookup can fire is not knowable at attach time — barriers appear
mid-run. Installing conditionally would need re-installation on every registry
mutation: a _larger_ diff touching all 6 paths, reintroducing the staleness
hazard.

### Benchmark — `scripts/agent/perf/bench-barrier-overlay.ts` (committed)

Same-process, interleaved, rotating lead, `WARMUP_SWEEPS = 4`, paired per-round
ratios, 15 rounds × **4 process invocations** (3 mine, plus one independent
re-run by the parent session on a different quiet machine). Ratios are
AFTER-vs-BEFORE, >1 means AFTER is faster.

| panel                                           | observed medians               | worst single round | rounds won             |
| ----------------------------------------------- | ------------------------------ | ------------------ | ---------------------- |
| `hasClearLineOfSight` close approach (≤6 ft) ⚠️ | 1.171, 1.178, 1.180, **1.296** | 0.651x             | 13, 15, 14, **11** /15 |
| `hasClearLineOfSight` waypoint (≤48 ft)         | 1.190, 1.254, 1.258, 1.275     | 0.953x             | 15, 14, 15, 15 /15     |
| **`isTileTraversable` tile probes (GROUND)**    | 1.303, 1.343, 1.372, 1.458     | 0.714x             | 14, 13, 15, **15** /15 |

**These are observed values, not bounds — and that distinction was earned the
hard way.** I originally published "1.171–1.180x" and "1.343–1.458x" as ranges
off 3 invocations. The independent 4th landed **outside both, in opposite
directions** (1.296 and 1.303). A 3-invocation spread is not an interval you can
publish as a bound; the across-invocation spread is itself under-sampled at n=3.
Expect ±0.1x on every figure here.

**The close-approach panel is the weak one** and must not be folded into a
single confident headline: 11/15 with a worst round of 0.923 in the independent
run, and the bench itself printed ⚠️ on it.

**The strongest panel is also the one that matters most.** `isTileTraversable`
was 15/15 with a worst round of 1.239 independently, and it is the
`hasBarrierAtTile` path — 19.4 M calls/run, the bigger half. For contrast, the
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
lowest median speedup observed across all 4 invocations):

```
hasClearLineOfSight:  7.45% × (1 − 1/1.171) = 7.45 × 0.1460 = 1.088%
isTileTraversable:    1.11% × (1 − 1/1.303) = 1.11 × 0.2325 = 0.258%
                                                    total  ≈ 1.35%
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
| **M5** emptiness verdict cached on first query instead of re-read      | invalidation removed     | **5 red**                                                              |

M1 and M5 are the two required hazard mutations — force-empty and never-re-read.
Both fail loudly. M5 takes down both mid-run barrier tests plus the explicit
`never caches a per-call answer across mutations` test.

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
5. **Verify your mutation actually applied before believing that it passed.**
   M5's first attempt patched with CRLF line endings against an LF file. The
   `String.Replace` silently matched nothing, the suite came back 36/36 green,
   and the obvious reading would have been "M5 passes, so the test is
   decorative". Printing the count of installed mutation sites — not just the
   test outcome — is what caught it. A no-op mutation and a genuinely weak test
   look identical from the test output alone.
6. **Enumerate the invalidation surface before choosing a caching strategy.**
   Counting the writers into `blockedTiles`/`ringShapes` is what surfaced the
   wholesale `world.barriers` reassignment in `scenario-presets.ts:150` — a path
   that bumps no `version`, and would therefore have defeated a version-stamped
   cache while the live-size read is immune to it. The count is the argument.
7. **A 3-invocation spread is not a bound — publish "observed", not a range.**
   I published `1.171–1.180x` and `1.343–1.458x` off 3 invocations. An
   independent 4th landed **outside both, in opposite directions** (1.296 and
   1.303). The across-invocation spread is itself under-sampled at n=3, and a
   tight-looking interval invites readers to treat it as a bound it never
   earned. List the observed medians, say they are observed, and expect ±0.1x.
8. **Report the weak panel as weak instead of averaging it away.** The
   close-approach panel scored 11/15 independently with a worst round of 0.923 —
   the bench printed ⚠️ on it and I should have carried that warning into the
   headline rather than folding it into one confident number alongside two
   unambiguous panels. The honest framing is that the verdict rests on
   `isTileTraversable` (15/15, worst 1.239) — which is also the path that
   matters most, at 19.4 M calls/run.
