# Session Handoff: Floor 1 post-boss farm-window stair livelock

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (🎯 Exact). A one-line production behavior change, but it
needed sweep-scale reproduction, event-log timeline diagnosis, two new deterministic
regression tests, and a full 300-run release Floor 1 leg to prove the gate.

## Issue

Closes nalfeo/Crawler#3351.

## What Was Done

The release sweep at `d143f15a` dropped the Floor 1 leg from 300/300 to 296/300, with
the published failure signature
`floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=11|weapon=throwing-knife`.

Reproduced deterministically with the sweep's exact `runHeadless` option set
(`npm run ai:winrate-sweep -- --seeds 11 --weapons throwing-knife --floor floor1`
→ 0/1, `timeout` at 660s, dominant state `suppressedProgressNav 52.8%`). Dumping the
per-sample decision timeline showed the staircase boss dying at ~228s and the player
then parking at `(924, 495)` from 229s to the 660s frame cap, thrashing every frame
between the pre-exit `Loot sweep: xp …` behavior and `Heading to the stairs to clear
the floor`, with the explore-dwell watchdog re-arming `progressGoalSuppressed`
(`source: exploreDwellFrontierTarget`) from ~315s onward — a permanent livelock.

Root cause: PR #3276 added the post-boss farm window (`isFarmingPostBossFloorTime`)
and wired it into the auto-progression **driver** and into the **legacy**
`take-stairs` branch of `findProgressObjective`. But `findProgressObjective`
delegates to `resolveFloor1MiddleChainObjective` (the goal-graph planner) whenever
`world.floorMap` exists — which is every real run — so the legacy branch is dead code
and the live goal-graph `take-stairs` branch had no farm-window check. The provider
therefore steered to the staircase while the driver refused to confirm the descend:
exactly the provider/driver disagreement that `post-boss-farm-window.ts` documents
itself as existing to prevent.

Fix: the same `isFarmingPostBossFloorTime` guard now runs at the top of the
goal-graph `take-stairs` branch, so the provider holds the stair objective for as
long as the driver will refuse it.

Observed in the real headless pipeline (not a lab) — before: seed 11 /
throwing-knife timed out at 660s (level 7, 89 kills); after: victory at 512s
(level 14, 247 kills, 724 gold).

## Key Decisions Made

- **Fix the provider, not the driver.** Removing the driver's farm-window hold would
  also have cleared the livelock, but it would have deleted the post-boss farm
  feature that #3276 deliberately shipped. Restoring provider/driver agreement is the
  smaller and more faithful change (AGENTS.md rule #11).
- **Left the legacy branch in place.** It is unreachable today but is the correct
  behavior for a `world.floorMap`-less world; deleting it is a separate cleanup.
- **Did not touch the cleared-arena safe room** (`world.clearedSafeRoomIds`, also
  from #3276). It explains the `inSafe` flicker at the stall site and the 82s of
  safe-room credit that made the raw 660s frame cap bite, but it is not the root
  cause and changing it would have been unscoped balance drift.
- **Two-level regression coverage.** A unit test pins the goal-graph contract
  directly (fast, fails pre-fix, will catch any future re-divergence at the exact
  call site); a headless test pins the real seed-11 pipeline end to end.

## What's Next / Blockers

- The `floor1-chain` leg also regressed in the same sweep (56.00% → 51.33%). That leg
  has no 100% requirement, so it was out of scope here, but it plausibly shares this
  root cause and is worth re-measuring after this lands.
- The dead legacy `take-stairs` branch in `findProgressObjective` is a cleanup
  candidate: any invariant added to one branch and not the other silently does
  nothing.

## Retrospective

### Lessons Learned

- **`npm run ai:headless` is NOT the sweep.** The CLI applies a persona config,
  `enemyTelegraphMs`, `playerPersona`, a wall-clock cap, and
  `eventSampleInterval: 15`; `winrate-sweep.ts` calls `runHeadless` with a bare
  `BehaviorTreeAI` and `eventSampleInterval: 60`. The CLI **won** seed 11 while the
  sweep **lost** it. Always reproduce a sweep failure through the sweep, or through a
  harness that replicates its exact option set.
- **tsx diagnostic scripts must live inside the repo.** A scratch script in `/tmp`
  fails with "Top-level await is currently not supported with the cjs output format"
  because the package's `"type": "module"` does not apply there. Put throwaway
  harnesses in the gitignored `files/` directory instead.
- **A "provider and driver must agree" doc comment is not a gate.** The contract was
  written down in `post-boss-farm-window.ts` and still broke within one PR. The unit
  test added here is the enforcement the comment was standing in for.

### Mistakes Made

- Burned an early cycle diagnosing with `npm run ai:headless`, which won the
  supposedly-failing seed. The early signal was that the reported signature includes
  the sweep's own option fingerprint (`forceWeapon=true|damage=1`) — if the repro
  command does not set those the same way, it is not the same run.
- Initially assumed the legacy `take-stairs` branch that already had the farm-window
  check was the live one. The early signal was that
  `resolveFloor1MiddleChainObjective` returns non-`undefined` for any world with a
  `floorMap`, so the code below its call site can never run in a real game.

### Opportunities for Future Improvement

- A deterministic guard could assert that every Floor 1 progress objective kind
  handled in the legacy `findProgressObjective` switch is also handled in the
  goal-graph switch, which would have caught this at authoring time rather than in a
  release sweep.
- Sweep failure signatures would be far cheaper to act on if the sweep emitted a
  copy-pasteable single-run repro command alongside each loss.
