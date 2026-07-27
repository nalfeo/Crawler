# Perf investigation: allocation churn in `hasClearLineOfSight` — no measurable win

**Date:** 2026-07-27
**Branch:** `nalfeo-perf-los-allocation-churn`
**Apples:** estimated 3🍎, actual 2🍎 (the implementation was measured and rejected; what shipped is a bench + this writeup)

## Systems touched

ai-behavior-tree, mapgen

## TL;DR

`hasClearLineOfSight` is the hottest leaf in the headless sim (**7.47% self /
7.63% total**, `npm run perf:profile` at `278bcf51a`). The standing hypothesis
was **allocation churn**: the sampling loop calls `FloorMap.isPassableAt` and
`FloorMap.worldToTile` 2-4x per sample step, and both allocate a throwaway
`{x, y}`.

**The hypothesis did not survive measurement.** Removing every one of those
allocations measures at **0.897x-1.111x median** across seven process
invocations, with a worst paired round of **0.338x** and **never a large
majority of rounds won** (best was 11/15). There is no shipping-grade win here.

The likely reason is that V8's escape analysis already scalar-replaces the
non-escaping `{x, y}` once these small methods inline — but that is an
*explanation*, not something this work demonstrates. What is demonstrated is the
absence of a measurable production win. The barrier callbacks (below) could
equally be masking a cheap allocation.

**No source change shipped.** What shipped is
`scripts/agent/perf/bench-line-of-sight.ts` — the evidence, plus a `--barrier-share`
diagnostic that identifies where the time in this function actually goes.

**The real cost is the barrier overlay.** `isPassableAt` consults two barrier
callbacks per probe, and merely *consulting* them is **30-56% of
`hasClearLineOfSight`'s cost on this panel** (1.438x-2.275x across 8 panels,
**15/15 rounds won in every one**, worst round 1.085x). On the Floor-1 combat
fixture the barrier registry is **empty** — 0 handles, 0 blocked tiles, 0 ring
shapes — so that entire cost is an always-false query. That is the next target.

## Measurements

All numbers are same-process, interleaved, rotated-lead, `WARMUP_SWEEPS = 4`,
15 rounds x 60k (close) / 30k (waypoint) calls, paired per-round ratios.
Ratio > 1 means the candidate is faster.

### Candidate (allocation removal) — production-shaped, barriers attached

| invocation | regime   | SCALAR-MAP                  | SCALAR-BOTH                 |
| ---------- | -------- | --------------------------- | --------------------------- |
| 1          | close    | 0.925x (worst 0.808, 6/15)  | 0.987x (worst 0.866, 6/15)  |
| 1          | waypoint | 0.940x (worst 0.396, 4/15)  | 0.978x (worst 0.358, 4/15)  |
| 2          | close    | 0.909x (worst 0.775, 1/15)  | 0.964x (worst 0.840, 4/15)  |
| 2          | waypoint | 0.942x (worst 0.837, 5/15)  | 0.975x (worst 0.692, 7/15)  |
| 3          | close    | 0.958x (worst 0.856, 3/15)  | 0.991x (worst 0.662, 5/15)  |
| 3          | waypoint | 0.972x (worst 0.646, 7/15)  | 1.111x (worst 0.521, 10/15) |
| 6          | close    | 0.922x (worst 0.659, 6/15)  | 0.897x (worst 0.540, 6/15)  |
| 6          | waypoint | 1.035x (worst 0.338, 8/15)  | 1.082x (worst 0.870, 9/15)  |
| 7          | close    | 0.986x (worst 0.728, 6/15)  | 1.014x (worst 0.931, 11/15) |
| 7          | waypoint | 1.007x (worst 0.712, 8/15)  | 1.017x (worst 0.799, 10/15) |

(Invocations 4-5 were the `--no-barriers` upper-bound runs, below. 6-7 were re-run
after the review fixes; the timed code paths are unchanged by those fixes, so 1-3
remain valid. Invocation 6 landed on a loaded machine — `SHIPPED` median 0.721
us/call vs 0.187 in invocation 7 — which is exactly the noise regime the
worst-round headline exists to expose.)

`SCALAR-MAP` = allocation-free `isPassableAt` only. `SCALAR-BOTH` adds the
scalar-tile-tracking loop with hoisted deltas.

**Headline (worst single round): 0.338x. Median range: 0.897x-1.111x. Best
rounds-won in any panel: 11/15 (73%), never a large majority.**

Two panels did post a median above 1.0 (waypoint, invocations 3 and 6-7). They
did not reproduce as a consistent effect and never cleared the rounds-won bar, so
the honest reading is "indistinguishable from noise", not "a small win".

### Could the harness be biased *against* the candidate?

Yes, in three ways, all of which a reviewer raised and none of which is large
enough to invert the conclusion:

1. `SCALAR-MAP` replaces one `worldToTile` call with **two** (`worldToTileX` +
   `worldToTileY`), so it is not a pure allocation ablation — it trades an
   allocation for an extra dispatch.
2. The candidates live on a `FloorMap` **subclass**. Each timed call site is
   monomorphic (the loops are duplicated per receiver type for exactly this
   reason), but shared inherited helpers see both receiver shapes, so transitive
   inline caches can go polymorphic.
3. The symmetric barrier delegation adds one indirection to **both** sides. It
   removes a much larger confound (see "Things that bit me" #1) but it does
   dilute a small candidate gain.

A **reverse-role** run — candidate as the real `src/` code, pre-change version as
the subclass — measured 0.966x-1.034x, which argues against a large subclass tax.
That run required `src/` edits and so is **not reproducible from the committed
bench**; weight it accordingly.

The correct summary is therefore **"no shipping-grade production win"**, not
"clean mechanistic falsification". These confounds could hide a *small* win; they
could not manufacture the flat result observed across seven invocations.

### Upper bound (`--no-barriers`, NOT production shaped)

With the barrier callbacks removed, tile conversion is the largest remaining part
of `isPassableAt`. This is the most favourable setting the harness can construct
for the allocation fix (not a proven theoretical maximum — the confounds above
still apply):

- close: **1.051x** median, worst round 0.567x, 10/15 rounds won
- waypoint: **1.080x** median, worst round 0.904x, 14/15 rounds won

Even here it does not clear the bar, and this configuration is not shippable
anyway.

### Diagnostic: barrier-overlay share (`--barrier-share`)

| invocation | regime   | ratio  | worst round | rounds won |
| ---------- | -------- | ------ | ----------- | ---------- |
| A          | close    | 1.588x | 1.321x      | 15/15 ✅   |
| A          | waypoint | 1.955x | 1.750x      | 15/15 ✅   |
| B          | close    | 1.438x | 1.085x      | 15/15 ✅   |
| B          | waypoint | 2.275x | 1.279x      | 15/15 ✅   |
| C          | close    | 1.789x | 1.209x      | 15/15 ✅   |
| C          | waypoint | 1.799x | 1.339x      | 15/15 ✅   |
| D          | close    | 1.755x | 1.684x      | 15/15 ✅   |
| D          | waypoint | 2.112x | 1.330x      | 15/15 ✅   |

Barrier share of the function = `1 - 1/ratio` ⇒ **30-56%**. Note the contrast in
_signature_: **15/15 rounds won in all eight panels** with every worst round
above 1.0, versus the candidate's 1-11/15 with every worst round below 1.0. That
is what a real effect looks like next to noise on the same rig.

**What this is measuring — read before quoting it.** On the Floor-1 combat
fixture the barrier registry is **empty**: the bench now prints
`0 handle(s), 0 blocked tile(s), 0 ring shape(s)`, and both variants return
**identical sink counts** (close 54180 vs 54180, waypoint 14859 vs 14859),
proving they sample exactly the same segments. So this is a clean apples-to-apples
delta, but what it isolates is the cost of **consulting an always-false overlay**:
a closure call, `tileMap.index`, a `Set.has` miss, and a second closure that
short-circuits on `ringShapes.size === 0`. It is **not** the cost of live
barriers.

An earlier draft of this handoff claimed the figure was a *lower* bound because
"barriers block segments and blocked segments exit the loop early". That
reasoning is sound in general but **false for this fixture**, where no barrier
exists to block anything. Corrected here; the bench now prints the registry sizes
and sink counts so the reading cannot be guessed wrong again.

That correction makes the target *more* attractive, not less: 30-56% of this
function is being spent asking an empty registry a question whose answer is
always false.

## Amdahl

Formula (matches `npm run perf:profile -- --ceiling <share>:<speedup>`):
`saving = share x (1 - 1/speedup)`.

- Candidate, at its own _upper-bound_ 1.08x on a 7.47% component:
  `7.47 x (1 - 1/1.08)` = **0.55% end-to-end**. Production-shaped it is ≤ 0,
  so the honest figure is **0%**.
- Barriers, taking the low end of 30% of a 7.47% component = 2.24% of total.
  Making them 2x faster: `2.24 x 0.5` = **~1.1% end-to-end**.

**Caveat on that 1.1%, stated plainly.** The 30% comes from this bench's
*synthetic* segment mix (uniformly drawn close-approach and waypoint segments),
not from the production-weighted mix of real LOS calls the profiler saw. So 30%
is a floor **for the measured panel**, not a proven floor for the profiler's
7.47%. Pushing in the other direction, the estimate ignores every other
`isPassableAt` caller — movement and pathfinding also pay this overlay cost and
are outside the 7.47%. Anyone acting on this should first instrument the real
call-length/result distribution, or replay captured production LOS endpoints,
rather than multiplying a microbench share by a profiler share.

Either way the ordering is not close: ~1.1% (with the above caveats) versus a
hard 0.55% ceiling that measurement then knocked down to 0%.

## Neutrality

`npm run perf:fingerprint -- --check` vs a baseline written from a verified-clean
tree at `5f11f52d7`:

```
Runs:    24
Hash:    b311a7808b9e94cadd14d4733df332aee4560565f0a8fe3fb8528f3fe7c8e37e
RunStats identical: every run in the sample matches the baseline byte-for-byte.
```

**24/24 byte-identical.** This is trivially true — the shipped diff contains no
`src/` change at all — and is recorded for completeness rather than as evidence.
The same hash matches the one in `2026-07-26-astar-grid-pathfinding.md`.

The bench's own oracle is the load-bearing correctness check: it compares the
candidate against the shipped function on **8008 segments** (including
degenerate/boundary fixtures) for both the returned boolean **and the ordered
probe trace**. `isPassableAt` is caller-supplied via `LineOfSightMap` and is not
required to be pure, so return-value equality alone would not catch a pruned or
reordered probe.

## Things that bit me (read before benchmarking `FloorMap`)

1. **Barrier lookups are installed on the real Floor-1 map, and not on a fresh
   clone.** `attachBarriersToFloorMap` (`src/core/barriers/wiring.ts:26,36`)
   installs both callbacks at floor load. `isPassableAt` short-circuits on
   `barrierLookup === null`, so timing the real map against a bare clone gives
   one side two live callbacks per probe and the other side nothing. This flipped
   my result by ~1.6x, in _both_ directions across two revisions, and had nothing
   to do with the change under test. Also, `null -> function` is a hidden-class
   transition, so the two maps may not even share a V8 map. Verify with a probe;
   the fields are private with setters and no getters.
2. **Running the equivalence oracle before the timing panels poisons the
   timing.** The oracle needs recording subclasses; feeding a second receiver map
   into a variant makes that variant's inline caches polymorphic. My first
   revision did this and made the one variant it happened to leave monomorphic
   look ~1.3x better than it was. Time first, oracle last.
3. **Sub-millisecond rounds are unusable.** 3000/1500 segments put a round under
   1 ms, and paired ratios swung 0.64x-1.37x on byte-identical work. Size rounds
   to ~10-25 ms.
4. **`SeededRandom` has `next()` / `nextInt(min, max)`. There is no
   `nextFloat()`.**
5. **Do not assume a "detach X and compare" diagnostic is a lower bound.** I
   claimed the barrier-share number was a floor because barriers block segments
   and blocked segments exit early — true in general, but the Floor-1 combat
   fixture has an **empty** barrier registry, so nothing blocked anything and
   both variants did identical work. Print the registry sizes and both variants'
   result counts; if the counts match, the variants sampled identically and the
   "early exit" argument does not apply. A reviewer caught this, not me.
6. **Order the drift guard after timing too, not just the oracle.** Lesson #2
   applies to *any* check that needs a recording subclass. My drift guard
   originally ran before the panels and fed a recording map straight into two
   of the three timed functions.

## Recommended next step

Target the barrier overlay in `isPassableAt`, not the tile math. The key fact is
that on the Floor-1 combat fixture the registry is **empty for the whole run** —
so every one of those probes is asking a question whose answer cannot be
anything but false. Sketches, in rough order of leverage-to-risk:

- `isBarrierPointBlocked` is consulted on **every** probe even when the floor has
  no analytic barriers at all. It already short-circuits on
  `ringShapes.size === 0` *inside* the callback — but only after paying the
  closure call. Hoisting that emptiness test to the `FloorMap` level (a flag the
  registry keeps current) would skip the call outright.
- Same for `isBarrierTile` when `blockedTiles` is empty — currently it still pays
  a closure call plus `tileMap.index()` before the `Set.has` miss.
- The tile lookup recomputes `tileMap.index(tileX, tileY)`
  (`src/core/barriers/wiring.ts:29`) inside the closure even though
  `isPassableAt` has already computed the same tile coordinates.

Note the emptiness fast-path must stay **live**: barriers are created and dropped
at runtime (spawner arenas), and `registry.version` already bumps on every
mutation, so a cached flag has an existing invalidation signal to key off.

Any of these must clear the same bar: bit-identical `RunStats` fingerprint,
ordered-probe-trace equivalence, and a worst-round-headlined paired bench.
Before quoting an end-to-end number, do the production-weighting work flagged in
the Amdahl caveat above.

## Files

- `scripts/agent/perf/bench-line-of-sight.ts` — new. Bench + ordered-probe-trace
  oracle + `--no-barriers` upper-bound mode + `--barrier-share` diagnostic (which
  prints live barrier-registry sizes and both variants' result counts, so the
  reading cannot be guessed wrong). It also self-checks that **both** local
  copies of the shipped loop have not drifted from `hasClearLineOfSight` — on
  result *and* ordered probe trace — and fails loudly if they have.
- No `src/` changes.

## Review

Ran at 3🍎: separate-model plan review (`gpt-5.6-sol`) and code review
(`gemini-3.1-pro-preview`). See
`docs/knowledge/review-ledgers/2026-07-27-los-allocation-churn-falsified.review-ledger.json`.

Both reviewers agreed the "ship nothing to `src/`" decision is correct. Between
them they found 9 real issues, all of which are fixed above:

- 4 bench-hygiene defects (trace-buffer desync, oracle subclasses inlining
  `isPassableAt` and able to silently drift, drift guard comparing only booleans
  and only one of the two copies, non-exception-safe world mutation in the
  diagnostic).
- 5 accuracy overstatements in this handoff — the "0.91x-1.05x, never a win"
  range that contradicted a recorded 1.111x, an unqualified escape-analysis
  causal claim, an over-strict worst-round pass criterion, an unsupported
  "most favourable possible" claim, and the false lower-bound argument for the
  barrier diagnostic.

The last one was a genuine factual error caught by re-deriving the fixture state,
and is why the diagnostic now prints what it is measuring.
