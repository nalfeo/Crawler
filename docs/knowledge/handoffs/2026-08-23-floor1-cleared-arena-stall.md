# Session Handoff: Floor 1 cleared-arena stall (release sweep loss at d143f15a)

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, boss-rooms, quests

## Apples

3🍎 estimated, 3🍎 actual — one shared predicate, one new world flag, the AI/scenario
consumers that read them, plus regression coverage and a 300-run sweep.

## What Was Done

Fixed issue #3352: the release sweep for `d143f15a` (PR #3276) dropped Floor 1 from
300/300 to 296/300, against a hard 100% requirement.

`d143f15a` made `isPointInSafeSpace` return `true` for any room in
`world.clearedSafeRoomIds`. Floor 1's final boss arena **owns the staircase**, and
`isPointInSafeSpace` is the engine's combat-suppression contract — it disables the
weapon, excludes enemies, pauses the floor-collapse deadline, flips the behavior tree
into `buildLeaveSafeRoomBehavior`, and stands down the anti-wedge dwell/ENGAGE
watchdogs. Clearing the arena therefore told the AI to leave the one room it had to
walk into, and removed the safety net that would have broken it out.

The fix splits the two meanings:

- `isPointInSafeSpace` is back to authored SAFE rooms + the safe spawn room only.
- New `isPointInClearedArena` + `world.playerInClearedArena` (maintained by
  `safeRoomSystem`) carry the cleared-arena concept.
- `isInSafeContext` is widened with `playerInClearedArena`, so a cleared arena still
  opens the customization/equip panels (ADR-0091's actual intent).
- `resolveNearestSafeAnchor` keeps its cleared-arena retreat branch untouched.
- Defence in depth: `resolvePostBossFarmWindow` now measures its reserve against
  `min(planningDeadlineMs, floorBudgetMs)`, so the window is bounded in `elapsedMs`
  even under a paused clock.

Observed in the headless runner (`npm run ai:headless -- --seed 1 --weapon
throwing-knife --floor floor1`) — before: `Outcome: STALLED`, "quest progress frozen
for 600s … stalled on: [floor1-leave-floor]", the player oscillating ~20 ft from the
staircase in the same room for ~570s; after: `VICTORY` in 34,469 frames.

## Key Decisions Made

- The overreach is in the predicate's _meaning_, not in one room's identity, so the
  fix narrows the predicate rather than special-casing `bossStairRoom`. The same trap
  would otherwise fire on any future floor whose exit sits in a boss room. Recorded as
  ADR-0092, amending ADR-0091's final decision bullet.
- Rejected a wholesale revert of #3276 — four of its five fixes are correct and
  unrelated.
- Rejected keeping the arena "safe" and patching the AI around it: that needs
  LeaveSafeRoom suppression _plus_ watchdog re-enablement _plus_ a farm-window rework,
  and still leaves the player weaponless at the exit with an unbounded collapse clock
  (which is also a scoring hole, since `isOfficialWin` discounts safe-room time).

## What's Next / Blockers

No blockers. Worth a future look: the goal-graph `take-stairs` branch in
`bt-ai-provider.ts` does not consult the post-boss farm window while the legacy stairs
branch does — harmless today, but the two paths should agree.

## Retrospective

### Lessons Learned

- **Ablation beat reading.** Three careful reads of the #3276 diff did not identify
  the culprit; commenting out the single `markBossRoomCleared(world,
floorMap?.bossStairRoom ?? null)` call and re-running the seed flipped STALLED →
  VICTORY in one 25s run. Reach for the one-line ablation earlier.
- **The tell was `remainingMs` frozen while game time advanced.** Any headless stall
  where a budget/deadline field is constant across hundreds of seconds means a pause
  path is stuck on, not that the budget is too small.
- `npm run ai:headless` rebundles from source, so temporary `console.log`
  instrumentation in `src/game/ai/**` does take effect — that is the fastest way to
  dump per-frame AI state.
- A boolean named for a _place_ ("is this room safe?") that is actually read as a
  _mode_ ("suppress combat and timers here") is a latent trap. Both predicates now
  carry doc comments naming the split.

### Mistakes Made

- Started a 300-run baseline sweep behind a `git stash` in the same worktree, then
  kept editing and committing in that worktree. The stash/pop raced the sweep and made
  its provenance unprovable, so it had to be thrown away and re-run. Early signal: a
  long-running background job and an active edit loop must not share a worktree —
  either dispatch the sweep to CI (rule #15) or finish edits first.
- Initially assumed the post-boss farm window was the cause because its `remainingMs`
  was visibly frozen. It was a _symptom_ of the same pause. Setting
  `postBossFarmReserveFraction: 1` still stalled, which ruled it out — run the cheap
  disproving ablation before building a theory on top of a correlated signal.

### Opportunities for Future Improvement

- A deterministic guard could assert that `isPointInSafeSpace` is never true for the
  room returned by `FloorMap.bossStairRoom` — the class of bug ("the exit is inside a
  suppression zone") is checkable without running a sweep.
- The stall detector reports the frozen quest but not _which_ suppression flags were
  active; adding `playerInSafeRoom`/`playerInClearedArena` to the stall diagnostic
  would have pointed at this in the first run instead of the tenth.
