# Handoff: fold the benchmark warmup/pairing lessons into the perf-optimizer skill

**Date:** 2026-07-27
**Persona:** DevOps Engineer (agent/skill tooling)
**Apples:** 1 estimated, 1 actual (tooling/docs-only)

## Systems touched

mcp-tooling, ci-policy

## Outcome

Two hard-won measurement lessons were living in the wrong place — as comments
inside individual bench scripts — where the next agent would never find them.
Both are now in `.github/skills/perf-optimizer/`, which is what an agent
actually reads before it measures anything.

This is the same failure mode as the defect fixed in PR #2068: a rule with no
reachable home gets skipped. There, step 3 mandated recording a cost share but
no command could produce one. Here, `bench-pathfinding.ts` documented the
warmup requirement in a file that is only opened by someone already benchmarking
pathfinding.

### Lesson 1 — warmup, and how benches lie

An early version of `bench-pathfinding.ts` used a single untimed warmup sweep.
A reviewer re-ran **byte-identical code** three times and got medians of
**4.71x, 8.13x, and 8.42x**. V8 was still tiering during the first timed rounds,
and whichever variant led absorbed the cost. A 1.8x spread on identical code is
wider than most wins the agent will ever find.

`references/measurement-recipes.md` now requires:

- **several rotated warmup sweeps** (`variants[(w + i) % variants.length]`), so
  tiering pressure lands symmetrically on every variant;
- **paired per-round ratios** — compute `before/after` within a round and take
  the median of those ratios. A machine-wide stall inflates every variant in a
  round together, so pairing cancels it; separately-aggregated medians do not,
  and make a consistent win look like overlapping noise;
- reporting **rounds won** and the **worst single round** as the headline;
- a **range across ≥2 separate process invocations**, because one invocation's
  median is itself a sample.

`SKILL.md` step 7 now states the reporting shape directly, so it is visible
without opening the reference.

### Lesson 2 — exact-equivalence replacement is a distinct neutrality category

`SKILL.md`'s "not neutral" list already warned against "a cheaper pathfinder
that picks a different tile". PR #2076 did replace the pathfinder — and stayed
neutral, because it reproduced rot-js's tie-breaking, iteration order, and
side-effect call pattern exactly.

The neutral list now names that category and states its price of entry: an
explicit ordering contract, a **differential oracle** comparing both
implementations element-by-element across thousands of fixtures (on top of the
fingerprint), and a fallback to the original for input shapes the fast path
cannot represent. `src/core/map/astar-grid.ts` is cited as the worked example.
If you cannot write the contract down, you are in the "different result" case.

## Audit trail for PR #2076 (independent verification)

Recorded here because the numbers were verified by a second party, which is the
standard this loop is trying to hold:

| claim                     | independent check                                             | result                                                        |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| byte-identical `RunStats` | baseline re-recorded from clean `origin/main`, then `--check` | 24/24 identical, hash `b311a780…7c8e37e` — matched            |
| ~7–8x, worst round 4.58x  | `bench-pathfinding.ts` re-run on a quiet machine              | 8.25x / 7.51x median; worst rounds 6.80x / 4.57x; 9/9 won     |
| equivalence to rot-js     | differential oracle run in-process                            | 4,350 comparisons, all byte-identical                         |
| ≈14% end-to-end           | Amdahl arithmetic on the reported self-shares                 | 16.16% → 2.55% self implies 14.0% and 7.45x in-situ — coheres |

The ≈14% is derived from **profile shares**, not a cross-process wall-clock
delta, so it does not repeat the PR #1973 trap. The profiler and the microbench
independently agree on ~7.4x, which is the cross-validation worth wanting.

## Follow-ups

- The next hunt should **re-profile first**: after a ~14% end-to-end reduction
  every share has shifted. Prior leaders were `hasClearLineOfSight`
  (`src/game/ai/bt-ai-geometry.ts`), `computeFlowField`
  (`src/core/map/flow-field.ts`), and `planObjectiveRoute`.
- Apply the step-3 identity gate to any `node_modules` row before targeting it.
