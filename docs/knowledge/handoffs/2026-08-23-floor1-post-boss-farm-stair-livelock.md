# Session Handoff: Floor 1 post-boss farm-window stair livelock (investigation, no fix landed)

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

2🍎 estimated, 2🍎 actual (🎯 Exact). The branch now carries no production change —
the attempted one-line fix was measured, found to be a net win-rate regression, and
reverted. What remains is documented evidence.

## Issue

Relates to nalfeo/Crawler#3351 (does **not** close it).

## What Was Done

### Diagnosis (stands)

The release sweep at `d143f15a` dropped the Floor 1 leg to 296/300 with the published
signature `seed=11|weapon=throwing-knife`: a livelock that parks the run at the
staircase until the 660s frame cap, dominant state `suppressedProgressNav`.

PR #3276 added the post-boss farm window (`isFarmingPostBossFloorTime`) and wired it
into the auto-progression **driver** and into the **legacy** `take-stairs` branch of
`findProgressObjective`. That legacy branch is dead code — `findProgressObjective`
delegates to `resolveFloor1MiddleChainObjective` (the goal-graph planner) whenever
`world.floorMap` exists, which is every real run — and the goal-graph's own
`take-stairs` branch has no farm-window check. So on the live path the provider steers
to the stairs while the driver refuses to confirm the descend: the provider/driver
disagreement `src/game/ai/post-boss-farm-window.ts` documents itself as preventing.

**This asymmetry is real and still present on `main`.**

### Attempted fix and why it was reverted

Applying the same `isFarmingPostBossFloorTime` guard at the top of the goal-graph
`take-stairs` branch does fix the reported combo (seed 11 / throwing-knife: timeout
660s → victory 512s). But it makes the post-boss farm window **live for the first
time**, and farming instead of parking at the stairs is a net loss at PR tier.

Measured on the blocking gate's exact option set (`tests/headless/floor1-completion.test.ts`,
seed-selected weapons, `experienced_player`):

| seed | weapon   | baseline (`main`) | with the goal-graph farm hold                                   |
| ---- | -------- | ----------------- | --------------------------------------------------------------- |
| 5    | fireball | victory 541s      | **death 242s** (died farming ~60s after the boss)               |
| 22   | sword    | victory 541s      | **timeout 660s** (`EXPLORE 264s`, `suppressedProgressNav 178s`) |

That takes the `Headless Floor 1 Gate` from 25/25 to 23/25 against a 100% floor
(observed as the CI failure on this branch:
`win-rate 92% (23/25) below 100% floor — failures: [5:death@242s lv8, 22:timeout@660s lv10]`).

Trading two PR-tier wins for one release-tier win is exactly the kind of balance
regression AGENTS.md rules #11/#12 forbid papering over, so the production change and
its two regression tests were reverted. The branch is now behaviorally identical to
`main`.

### Alternative also tested and rejected

Keeping baseline routing but ignoring `progressGoalSuppressed` for an already-unlocked
staircase (so the stall's dominant `suppressedProgressNav` cannot recur) removes the
suppression but does **not** fix the combo: seed 11 / throwing-knife still times out at
660s, now dominated by `EXPLORE 543s`. The suppression is a symptom; the run's real
problem in that combo is that it never converges on the exit after the boss dies at
~141s.

## Key Decisions Made

- **Do not land a fix that lowers the blocking win-rate gate.** The gate is the
  established 25/25 Floor 1 baseline; a change that fixes one release-tier seed by
  losing two PR-tier seeds is a regression regardless of the sweep number it targets.
- **Do not tune the reserve fraction to dodge the gate.** Picking a farm reserve that
  happens to keep seeds 5 and 22 alive is cherry-picking (rule #12).
- **Leave `main`'s asymmetry documented rather than silently "fixed".** Making the
  farm window live is a balance change that needs a full sweep and a Game Designer /
  Playtester loop, not a CI-recovery one-liner.

## What's Next / Blockers

- **Decide the intent of #3276's farm window.** Either (a) make it live _and_
  re-baseline Floor 1 with a full release sweep, bounding the farm so the AI stays
  within return range of the stairs and does not fight itself to death, or (b) delete
  the driver-side hold and the dead legacy branch so the feature stops being
  half-wired. Today it is neither.
- **Seed 11 / throwing-knife is still failing** on the release tier, and its post-boss
  behavior needs its own diagnosis (boss dies ~141s; the remaining ~520s never
  converge on the exit).
- The other three release-leg losses are distinct signatures and unexamined:
  `5:sword death@224s (EXPLORE 52.3%)`, `38:pistol timeout (ENGAGE 52.4%)`,
  `1:throwing-knife timeout (EXPLORE 89.4%)`.
- `floor1-chain` regressed 4.67pp in the same sweep; unmeasured here.

## Retrospective

### Lessons Learned

- **Wiring a dormant feature into the live path is a balance change, not a bug fix.**
  The farm window looked inert-by-accident; turning it on changed run outcomes across
  the seed panel. Any "this guard was never reached" fix must be win-rate-measured on
  the gate panel _before_ it is proposed, not after CI rejects it.
- **`npm run ai:headless` is NOT the sweep.** The CLI applies a persona config,
  `enemyTelegraphMs`, a wall-clock cap and `eventSampleInterval: 15`;
  `winrate-sweep.ts` calls `runHeadless` with a bare `BehaviorTreeAI` and
  `eventSampleInterval: 60`. The CLI **won** seed 11 while the sweep **lost** it.
  Reproduce a sweep failure through the sweep's exact option set.
- **The PR gate panel and the release leg disagree about seeds.** Gate seed 11 selects
  `baseball-bat` and wins; the reported failure is seed 11 with a _forced_
  `throwing-knife`. Always restate which tier a seed number belongs to.
- **`suppressedProgressNav` dominance is a symptom, not a root cause.** Removing the
  suppression path for that objective just moved the same 660s timeout into `EXPLORE`.

### Mistakes Made

- Proposed the goal-graph guard without first running the 25-seed gate panel locally;
  CI found the two-seed regression instead. The cheap check (two seeds, ~3 minutes
  each) would have caught it immediately.
- Initially assumed the legacy `take-stairs` branch carrying the farm-window check was
  the live one. The early signal was that `resolveFloor1MiddleChainObjective` returns
  non-`undefined` for any world with a `floorMap`.

### Opportunities for Future Improvement

- A deterministic guard could assert that every Floor 1 progress objective kind handled
  in the legacy `findProgressObjective` switch is also handled in the goal-graph
  switch — it would flag the asymmetry at authoring time instead of leaving a feature
  half-wired.
- Sweep failure signatures would be far cheaper to act on if the sweep emitted a
  copy-pasteable single-run repro command (including forced weapon and sampling
  options) alongside each loss.
