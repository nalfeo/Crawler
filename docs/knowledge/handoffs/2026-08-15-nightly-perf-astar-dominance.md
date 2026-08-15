# Nightly perf: grid A\* drops dominated duplicate open-list pushes

**Date:** 2026-08-15
**Session slug:** `nightly-perf-astar-dominance`
**Apples:** 3🍎 estimated / 3🍎 actual
**Issue:** nalfeo/Crawler#2975
**Review ledger:** `docs/knowledge/review-ledgers/2026-08-15-nightly-perf-astar-dominance.review-ledger.json`

## Systems touched

mapgen, ai-behavior-tree

## Target selection (measure first)

`npm run perf:profile` on this checkout (3 headless Floor-1 runs, seeds 1-3 x sword,
23508 ms attributed, 5.0% startup overhead):

| rank | frame                    | self% | total% | note                                     |
| ---- | ------------------------ | ----- | ------ | ---------------------------------------- |
| 1    | `computeGridPath`        | 6.00% | 8.27%  | **chosen** — top game-code frame         |
| 2    | `hasClearLineOfSight`    | 4.61% | 4.66%  | picked over twice already (see below)    |
| 3    | bitecs `H`               | 3.41% | 4.42%  | third-party, 65+ callers, unattributable |
| 4    | `floodReachabilityDepth` | 3.40% | 3.74%  | already tight typed-array BFS            |
| 5    | `computeFlowField`       | 3.31% | 3.65%  | optimized 2026-07-31                     |

`hasClearLineOfSight` was **not** re-chased: `2026-07-27-los-allocation-churn-falsified.md`
falsified its allocation hypothesis and `2026-07-27-empty-barrier-overlay-fast-path.md`
already took the barrier-overlay win it identified. `computeFlowField` and the
effective-stats scratch buffers were the two previous nightly passes.

Attribution inside the chosen target, from a temporary counter patch over a real
seeds 1-3 x sword panel (8,490 searches):

```
open-list pushes   10,412,514
open-list pops      9,958,819   of which 4,141,050 (41.6%) STALE no-op pops
dominated pushes    2,782,898   = 26.7% of all pushes
max heap size            1,489
```

## What changed

`GridAStarScratch.push` (`src/core/map/astar-grid.ts`) drops a push when the tile
already has an open entry with `f <= newF`, tracked in two new generation-keyed
per-tile arrays (`openStamp`, `bestF`).

This is **inert, not a heuristic**. The dropped entry is ordered strictly after
the recorded one under `(f asc, h asc, entryId asc)` — within a search `h` is a
pure function of the tile, so equal `f` is an exact `(f, h)` tie and the earlier
entry also has the smaller id. The recorded entry is provably still on the heap
(any pop for a tile leaves it closed, and the expansion loop already refuses to
push onto a closed tile), so the dropped entry could only ever have been popped
**after** it — at which point the pop body is a bare `continue`. Dropping a push
shifts every later entry id down uniformly, preserving the only thing ids are
compared for. Full four-step argument is in the module header.

It is **not** a decrease-key: nothing is reordered, removed from the heap, or
relaxed, and no `isPassable` probe is skipped.

## Results

**Per-call (the honest headline).** `npx tsx scripts/agent/perf/bench-astar-dominance.ts`,
two separate process invocations, 15 paired rounds each, 4 rotated warmup sweeps,
alternating lead:

| panel                                  | worst paired round | median          | rounds won |
| -------------------------------------- | ------------------ | --------------- | ---------- |
| reachable pairs, real Floor-1 maps     | **1.250x**         | 1.319x - 1.349x | 30/30      |
| exhaustive (start walled off) searches | **1.338x**         | 1.362x - 1.381x | 30/30      |

**In-situ profile share**, `npm run perf:profile`:

| frame             | before        | after             |
| ----------------- | ------------- | ----------------- |
| `computeGridPath` | 6.00% / 8.27% | **4.86% / 7.45%** |

**End-to-end: inside noise, and reported as such.** The Amdahl ceiling for a 6%
component at 1.35x is 1.56% (`npm run perf:profile -- --ceiling 6.00:1.35`). The
per-call ratio and the profile-share drop are the win; do not quote a whole-run
percentage from this change. The plan reviewer flagged exactly this and it is
resolved by not making the claim, not by inflating it.

## Neutrality evidence

- `npm run perf:fingerprint -- --seeds 1-3 --weapons sword` (narrowed): hash
  `bf7e0e4b51e46c5d4aad4ff7f4058b6904909067ae8486e282c59aca2dd0770e` written on
  the clean tree, `--check` **byte-identical** after the change.
- Full gate sample (8 seeds x sword/bow/baseball-bat): baseline written at
  pre-change `67702ec9060ad902331ad5cbbc8da33cb57c040e` and checked at current
  `71d7c5a3da3d740fc618b406db9370b129b30bef`, hash
  `a2a6c5de1e5e5a71f105c7e1b5b08a340f0a02290834cb59859a898ae983364c`,
  **byte-identical**.
- Differential oracle in the committed bench: 212 fixtures x (path compared tile
  by tile **and** ordered `isPassable` probe trace compared entry by entry), all
  exact, across reachable / exhaustive-unreachable / degenerate `start === goal`
  cases on two independently generated real Floor-1 maps.
- `tests/ecs/astar-grid-equivalence.test.ts` (property-based, differential against
  real rot-js 2.2.1 including the probe trace): 36 tests green.
- This change is pure simulation CPU — no renderer, asset, or boot path is
  touched — so the fingerprint is the right instrument and no visual/e2e
  observation is owed.

## Test-design finding worth carrying forward

The first mutation run over the filter scored **50% (9/18 survived)**. Every
survivor made the filter prune **less**; every mutant that made it prune **more**
was killed. That is structural, not a gap in the suite: an inert optimization
cannot be pinned by a correctness test, because "disabled" and "correct" are the
same output. The fix was a **liveness pin** —
`__getGridAStarLastEntryCountForTests()` (reads `entryCount`, which the search
already leaves in place, so zero hot-path cost) plus a fixture with A/B-measured
entry counts (31x31: 1163 filtered vs 1845 unfiltered; 41x41: 2053 vs 3265).
Re-run: **9/9 killed, 100%**.

`npm run test:mutate -- src/core/map/astar-grid.ts:236-246 --tests tests/ecs/astar-grid-equivalence.test.ts`

The plan review also caught that the `MAX_GENERATION` wrap now clears two
generation-keyed arrays and was untested. `__forceGridAStarGenerationForTests`
makes the wrap reachable; the new test was **proven to fail** when
`this.openStamp.fill(0)` is deleted (it returns an empty path).

## Reproduce

```bash
npm run perf:profile
npx tsx scripts/agent/perf/bench-astar-dominance.ts        # run twice, quote the RANGE
npm run perf:fingerprint -- --seeds 1-3 --weapons sword --check files/perf-astar-dominance-baseline.json
npm run test:mutate -- src/core/map/astar-grid.ts:236-246 --tests tests/ecs/astar-grid-equivalence.test.ts
npm run verify:fast
```

## Next target for the following nightly pass

With `computeGridPath` at 4.86%, the ranking is now `hasClearLineOfSight` (4.75%,
twice picked over — read the two 2026-07-27 handoffs before touching it),
bitecs `H` (3.55%, needs caller attribution before it is a legal target), and
`floodReachabilityDepth` (3.52%). None is above the ~5% bar on its own; the more
promising direction is **call-rate** rather than per-call cost — e.g. how often
`floodReachabilityDepth` and the travel fields are recomputed per BT poll.

## State at end of session

Changes are committed and pushed to the PR branch for issue #2975.

The independent grade was **re-run against the committed sha** with
`npm run review:grade -- prompt/record` (grader `gemini-3.1-pro-preview`,
graded tree `5566d7a8`, 5/5/5/5/5, pass, 0 findings), so the ledger grade is now
bound to a clean tree rather than to a working-tree diff.

Still owed before merge:

1. the **full 24-run** `perf:fingerprint` gate sample on CI (rule 15 keeps broad
   samples off local compute; `gh` is unauthenticated in the session
   environment, so it could not be dispatched from here),
2. `npm run verify:pr-prereqs`.
