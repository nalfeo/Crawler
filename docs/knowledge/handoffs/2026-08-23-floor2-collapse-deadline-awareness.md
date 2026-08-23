# Session Handoff: Give the AI runner Floor-2 collapse-deadline awareness

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

3🍎 estimated / 3🍎 actual

## What Was Done

Closed #3326: the report-only release sweep legs `floor2` (36.00%) and
`floor1-chain` (56.00%) were far below the repo's 90% win-rate target.

Diagnosis used only the **already-published** per-run `RunStats` in the release
baseline payload on the `baselines` branch
(`by-sha/423370b8ea7c11c452225ca40449b4de2e2916a0.json`, the sha issue #3326
cites) — no new sweep was
dispatched. Outcome histograms: `floor2` = 54 victory / 89 timeout / 5 death /
2 stalled; `floor1-chain` = 84 victory / 60 timeout / 1 death / 5 stalled. The
dominant bucket is unambiguous: **115 of the 149 timeouts (77%) had already
killed all four Floor-2 family bosses** — so the exit staircase was spawned and
unlocked — with `floor2Progression.exitCompleted: false`. On the standalone
`floor2` leg the median run still had ~390 s of its 1200 s budget left when the
last den fell. The AI was not losing; it was refusing to leave.

Root cause: `BehaviorTreeAI.getCollapsePanicProfile()` built its input
exclusively from `world.floorScenario?.objective`. Floor 1 owns that objective;
`floor2Scenario.ts` sets `world.floorScenario = null`. So on Floor 2 the panic
profile was permanently `{ panic: 0, beeline: false, remainingMs: null }` even
though Floor 2 **does** collapse — `floor2ObjectiveTick` ends the run at
`getFloorManifest('floor2').timer.durationMs` (1_200_000 ms). The pre-exit loot
sweep (`buildLootSweepBehavior('pre-exit')`, Track A priority 2.5, **above**
Progress) uses `maxDistance = +Infinity` in that window and only surrenders on
`profile.beeline || profile.panic > LOOT_SWEEP_PANIC_THRESHOLD` — both
unreachable on Floor 2. The AI swept loot at infinite radius until the floor
collapsed under it.

Fix (confined to `src/game/ai/**`, no gameplay/data change): new
`src/game/ai/collapse-deadline.ts` exporting
`resolveManifestFloorCollapseState(world)`, which resolves the collapse deadline
for a floor whose timer lives on the floor manifest and whose staircase lives on
`world.floorExtendedState.familyState`. It is wired into three places:

- `getCollapsePanicProfile` — when there is no Floor-1 objective, the panic
  input is now built from the manifest deadline + staircase phase instead of
  falling back to the neutral profile.
- `refreshPlayerToStairsTravelEstimate` — now resolves the staircase from either
  the Floor-1 objective or the Floor-2 collapse state, so the panic ramp is
  travel-aware on Floor 2 too (A\* throttle logic unchanged).
- `autoFloor2ProgressionSystem` — passes the real deadline into
  `shouldDeferStairDescend` instead of the hard-coded `null`.

Two stale comments that asserted the opposite invariant (`bt-ai-tuning.ts` near
`LOOT_SWEEP_PANIC_THRESHOLD`, `auto-progression.ts`) were corrected. **No tuning
constant changed** — the existing panic ramp already surrenders the sweep at
roughly twice the travel estimate plus margin, which is exactly the wanted
behavior once the deadline is visible.

### Observe before done (real artifact, not a lab)

Before/after on the **headless runner** (`npm run ai:headless`, the real
pipeline the sweep legs use), not a lab:

- Seed 6 before: **TIMEOUT** — all 4 dens cleared at 938.1 s,
  `floor2-leave-floor` accepted 938.1 s / incomplete, `Exit: incomplete`.
- Seed 6 after: **VICTORY** at 1095.6 s, `floor2-leave-floor: accepted 938.1s,
✓ 1095.6s`, `Exit: completed`. Den timings identical up to 938.1 s — only the
  post-unlock phase changed. Stuck 25.2% → 20.6%, wiggle 11.8% → 9.0%.
- 11-seed local smoke (individual single-seed `npm run ai:headless` invocations
  per the issue's "observe before done" guidance, not a batch sweep-tool run, so
  the >10-run GitHub-dispatch rule for broad sweeps does not apply): nine
  previously-timeout seeds 1, 4, 6, 9, 14, 16, 18, 19, 23 → **7 of 9 now win**;
  two previously-victory seeds 2, 3 stayed victories; **no new deaths or
  stalls**. The two stragglers (1, 4) are the other, smaller bucket — they
  never cleared the 4th den at all (3/4 dens, kill-quota pacing), which this
  change does not target.
- Floor-1 neutrality: `npm run perf:fingerprint --check` reports **RunStats
  identical, byte-for-byte, over the full 24-run gate sample**. The Floor-1 code
  path is provably untouched.

The next release sweep is the canonical re-measurement of the leg win rates.

## Key Decisions Made

- **Floor 2 uses the raw manifest duration**, not
  `resolveFloor1PlanningDeadlineMs` and not a safe-room-credited deadline: the
  runtime compares raw `world.elapsedMs` against that constant, so any clamp or
  credit would make the AI's deadline disagree with the one that actually kills
  the run. A unit test locks this in.
- **`staircaseUnlocked` reuses the exact availability guard from
  `autoFloor2ProgressionSystem`** (unlocked && spawned && `staircasePos != null`)
  so the AI's panic phase-gating matches exactly when the descend would fire.
  Partial states (timer present but stairs not spawned, or spawned with no
  position) all read locked.
- **No priority-order change.** The plan review explicitly asked for the smaller
  travel-aware fix first, escalating to an explicit exit-priority override only
  if the tail persists. It did not need to; the sweep now surrenders on its own.
- **The resolver returns `null` for any floor that owns a
  `floorScenario.objective`**, which is what makes the Floor-1 byte-identity
  above structurally guaranteed rather than merely observed.
- **Did not touch map generation.** The residual bucket (seeds 1, 4 — dens not
  all cleared inside the budget) is a separate, smaller problem and is left for
  a follow-up rather than smuggled into this diff.
- The new module deliberately does **not** import `bt-ai-provider`, to avoid an
  import cycle between the provider and the resolver.

## What's Next / Blockers

- The `floor2` / `floor1-chain` legs are report-only, so nothing is blocked. The
  next release sweep re-measures the rate; that is the canonical number, not the
  11-seed local smoke.
- **Follow-up candidate:** the second timeout bucket — runs that never clear the
  4th den inside 1200 s because kill-quota hunting paces too slowly (repro:
  `--floor floor2 --seed 1` and `--seed 4`, both reach 3/4 dens). That is a
  pacing/target-selection problem, not a collapse-awareness one, and wants its
  own issue.

## Retrospective

### Lessons Learned

- The release baseline payload on the `baselines` branch carries **full per-run
  `RunStats`** for every leg. Categorizing 300 published runs by
  `outcome` × dens-defeated × `movementQuality` took minutes and pinned the root
  cause exactly — dispatching a fresh sweep would have cost an hour and told us
  less.
- "Timeout" is not one failure. Splitting the timeouts by _how far the run got_
  turned a vague 36% win rate into two crisply separable buckets (77% "finished
  the floor and refused to leave" vs 23% "never finished the floor"), only one
  of which was in scope.
- A capability that reads as global (`getCollapsePanicProfile`) can be silently
  Floor-1-only if it is sourced from a Floor-1-only state object. Floor 2 nulls
  `world.floorScenario` wholesale, so every consumer of it degrades quietly
  rather than failing loudly. Worth grepping for other `floorScenario?.` reads
  that assume they cover every floor.
- `npm run perf:fingerprint --write`/`--check` around a `git stash` is a cheap,
  decisive way to prove a Floor-1-neutrality claim instead of asserting it.

### Mistakes Made

- Wrote the integration test against a guessed `FloorMap` API
  (`roomGraph.values()`, `src/core/map/floor-map.js`) instead of reading it
  first — the real accessors are `floorMap.rooms` and
  `src/core/map/FloorMap.ts`, and cave rooms are irregular so interior anchors
  must come from `pickRoomAnchorCell`, not bounds centers.
- Recorded a ledger stage as a separate commit _after_ generating the grade
  packet, which invalidated the packet's `head_sha` and forced a re-grade.
  Commit all ledger/stage churn **before** running `review:grade -- prompt`.

### Opportunities for Future Improvement

- `floor2.manifest.json` still has no `implemented.winBudgetMs`, so floor2
  sweeps fall back to `FLOOR_AGNOSTIC_DEFAULT_MAX_FRAMES`; runs actually
  terminate at 72_001 frames because the 1.2 M ms collapse timer fires first.
  Now that Floor 2 wins reliably, a real budget could be derived from the
  observed win distribution.
- The pre-exit loot sweep's `maxDistance = +Infinity` is safe only because some
  deadline eventually reins it in. A floor that has neither a
  `floorScenario.objective` nor a manifest timer would reintroduce the exact bug
  class; a guard that refuses an infinite-radius sweep with no resolvable
  deadline would make that structural.
