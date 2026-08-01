# Handoff: nightly perf pass — flow-field BFS loop

**Date:** 2026-07-31  
**Slug:** nightly-perf-flow-field  
**Issue:** `nalfeo/Crawler#2466`  
**Persona:** perf-optimizer  
**Apples:** 3🍎 estimated → 2🍎 actual (📈 Over)

## Systems touched

mapgen, ai-behavior-tree, ai-pathfinding

## Summary

Ran the nightly gameplay-neutral perf pass for issue #2466 and targeted the
highest remaining measured self-time game-code hotspot on this checkout:
`computeFlowField` in `src/core/map/flow-field.ts`.

The landed change keeps the algorithm identical but removes hot-loop overhead:

- replaced the dynamic array queue with a fixed-size `Int32Array` FIFO
- inlined `idx -> x/y` decomposition
- unrolled the four cardinal neighbour probes while preserving the exact visit
  order (`right`, `left`, `down`, `up`)

Also added a committed reproduction bench:

- `scripts/agent/perf/bench-flow-field.ts`

That bench captures real Floor 1 maps from the headless runner, compares the
live implementation against a verbatim pre-change baseline, and reports
same-process interleaved paired ratios plus a post-timing differential oracle
that checks the full distance grid, FLYING traversal, and ordered
`isTilePassable` callback traces.

## Why this target

Before any code change, `npm run perf:profile` on this checkout showed:

- `computeFlowField` at **5.85% self / 5.90% total** (self-sorted/total-sorted
  runs were both in the ~5.7–5.9% band)
- `hasClearLineOfSight` just below it (~5.1–5.3% self)

That made `computeFlowField` the best low-risk local candidate still above the
noise floor, with a straightforward allocation / loop-overhead story and no
gameplay semantics change.

## Measurements

### Microbench (`npx tsx scripts/agent/perf/bench-flow-field.ts 15`)

All runs compare CURRENT vs the inlined pre-change BASELINE over **300 real
Floor-1 fixtures**. After timing, the bench also runs **16 option-bearing
oracle fixtures** (8 FLYING, 8 recording-callback) and checks both exact
distance-field equality and ordered callback-trace parity against the baseline.

Observed sequential invocations:

- worst round **0.89x**, median **1.20x**, rounds won **12/15**
- worst round **0.87x**, median **1.10x**, rounds won **9/15**
- worst round **0.73x**, median **1.13x**, rounds won **10/15**

This is still a median win, but not a clean sweep: every 15-round sample kept a
sub-1.0 worst paired round, so the microbench evidence is **marginal-positive**
rather than decisive on its own.

### Real profile (`npm run perf:profile`)

Before:

- `computeFlowField`: **5.68–5.85% self**, **5.90% total**

After final change:

- `computeFlowField`: **3.59% self**, **4.01% total**

The function dropped below `hasClearLineOfSight` and no longer appeared among
the top total-cost rows in the earlier range it occupied pre-change.

## Gameplay-neutrality

Local narrowed fingerprint only (per repo policy, full 24-run gate sample stays
on GitHub infrastructure / CI):

```bash
npm run perf:fingerprint -- --seeds 1-3 --weapons sword --write /tmp/perf-before.json
npm run perf:fingerprint -- --seeds 1-3 --weapons sword --check /tmp/perf-before.json
```

Result:

- hash before: `8410f59a816a38db8eb32c50e328fad8878ba6aa6052b8ee4dc2d35b2c951e9c`
- hash after: `8410f59a816a38db8eb32c50e328fad8878ba6aa6052b8ee4dc2d35b2c951e9c`
- **RunStats identical** on the covered sample

## Verification

- `npx vitest run tests/ecs/flow-field.test.ts tests/property/flow-field-properties.test.ts --reporter=dot`
- `npm run verify:fast`
- `npm run test:mutate -- src/core/map/flow-field.ts:77-167 --tests tests/ecs/flow-field.test.ts,tests/property/flow-field-properties.test.ts`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-31-nightly-perf-flow-field.review-ledger.json`

## Notes / blockers

- The issue requested a detailed plan comment on the GitHub issue before coding.
  I prepared that plan in-session, but **could not post it** from this
  environment because `gh auth status` reported the provided `GITHUB_TOKEN` as
  invalid.
- The full 24-run fingerprint gate was intentionally left for CI / GitHub
  infrastructure in line with the nightly perf issue requirements and AGENTS.md
  guidance on broad samples.
- The scoped mutation proof killed **74/82 mutants (92.68%)** over
  `src/core/map/flow-field.ts:77-167`. The 6 surviving mutants are all on the
  redundant outer edge guards around the unrolled probes (`rightX < width`,
  `leftX >= 0`, `downY < height`, `upY >= 0`). Those guards were added only to
  skip futile helper calls: `isTileTraversable()` already rejects out-of-bounds
  coordinates before any queue write, so the surviving mutations are
  equivalent/no-op under the function's current contract rather than evidence of
  an untested gameplay branch.
