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

This is a close cousin of the defect fixed in PR #2068, and the recurring shape
is the same: **a rule whose enforcement lives somewhere the agent never looks.**
In #2068 the profiler _did_ produce a cost share — the defect was that step 3
never required verifying the **identity** of the frame that share belonged to,
so a valid-looking 19% was confidently attributed to FOV when it actually
belonged to `AStar.compute`. Here, `bench-pathfinding.ts` documented the warmup
requirement correctly, but only inside a file that is opened by someone already
benchmarking pathfinding.

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

| claim                     | independent check                                             | result                                                     |
| ------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| byte-identical `RunStats` | baseline re-recorded from clean `origin/main`, then `--check` | 24/24 identical, hash `b311a780…7c8e37e` — matched         |
| ~7–8x, worst round 4.58x  | `bench-pathfinding.ts` re-run on a quiet machine              | 8.25x / 7.51x median; worst rounds 6.80x / 4.57x; 9/9 won  |
| equivalence to rot-js     | differential oracle run in-process                            | 4,350 comparisons, all byte-identical                      |
| ≈14% end-to-end           | Amdahl arithmetic on the reported self-shares                 | 16.16% → 2.55% self implies **14.0%** end-to-end — coheres |

The ≈14% is derived from **profile shares**, not a cross-process wall-clock
delta, so it does not repeat the PR #1973 trap.

**Correction worth recording, because it is the exact antipattern this loop
exists to catch.** The first draft of this handoff claimed the same arithmetic
also yielded a **7.45x** in-situ speedup that "landed inside" the bench band.
It does not. Holding non-pathfinding work constant:

```
T_after / T_before = (1 - 0.1616) / (1 - 0.0255) = 0.86034
in-situ speedup    = 0.1616 / (0.0255 x 0.86034) = 7.37x
```

**7.37x, not 7.45x** — and 7.45x was the _bench_ figure, quoted as though it
were the arithmetic result. Two independent checks were collapsed into one so
they would appear to agree exactly. They still agree _well_: 7.37x sits just
below the published 7.45–8.11x band and inside the 7.51–8.25x measured here.
But "close, from two independent methods" is the honest claim, not "identical".
A reviewer caught this; it was not self-caught.

## Guard staleness — telemetry defect found and fixed

Chasing "why is this session's guard telemetry nearly empty" turned up a real
safety hole, not a reporting one.

**The extension host loads guards once, at session start.** `authoring-main-sync`
merged at 2026-07-25T19:12; this session began at 06:08 the same day. For the
following two days the guard **was not running here** — 10 recorded events, all
PR-time. One `extensions_reload` took it to 12 within seconds, with
`authoring-main-sync` firing on the next `grep` and `powershell` call. Pulling
main does not reload extensions.

Across the 71 committed telemetry files, **68 contain only
`pr-preflight`/`pr-review-ledger` events** (2–14 events each); the 3 with real
per-tool coverage (176/238/371) are exactly the ones containing
`authoring-main-sync`. The two guard sets never co-occur. That is the signature
of load-time staleness at corpus scale.

Fixed by documenting **"run `extensions_reload` after every sync onto main"** in
`.github/extensions/copilot-guards/README.md` and in the AGENTS.md environment
quirks. Near-empty telemetry should be read as a prompt to reload.

(Field-name trap for anyone querying the jsonl: the key is `guard_id`, snake_case
— grouping on `guardId` silently returns nothing.)

## Correction to PR #2042's published FOV figure

Fixing `bench-fov.ts`'s warmup so the citation above is true immediately
re-priced its own headline. Under the corrected rotated warmup, two separate
process invocations (400 positions x 9 rounds):

| invocation | median paired ratio | worst round | rounds won |
| ---------- | ------------------- | ----------- | ---------- |
| 1          | 1.88x               | 1.63x       | 9/9        |
| 2          | 1.90x               | 1.30x       | 9/9        |

**~1.88–1.90x, worst round 1.30x — not the 2.10x published in PR #2042.** The
win is real and every one of 18 rounds went to CURRENT, but the published number
was ~10% optimistic because the single fixed-order warmup left V8 tiering during
the early rounds, and BASELINE ran first and absorbed it. This is the same bias
the rule was written to prevent, and it was sitting in our own merged work. The
optimization does not need revisiting; the number does.

## Follow-ups

- The next hunt should **re-profile first**: after a ~14% end-to-end reduction
  every share has shifted. Prior leaders were `hasClearLineOfSight`
  (`src/game/ai/bt-ai-geometry.ts`), `computeFlowField`
  (`src/core/map/flow-field.ts`), and `planObjectiveRoute`.
- Apply the step-3 identity gate to any `node_modules` row before targeting it.
