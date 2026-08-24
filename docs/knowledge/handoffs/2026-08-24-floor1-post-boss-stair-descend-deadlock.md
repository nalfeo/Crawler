# Session Handoff: Floor 1 post-boss stair-descend deadlock (issue #3449)

## Date

2026-08-24

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree

## Apples

3🍎 estimated, 3🍎 actual (🎯 Exact). Removal of a half-wired AI feature plus a
semantic fix to the stair-descend deferral window, across 8 source/test files,
with headless before/after measurement and two blocking-gate reruns.

## Issue

Closes nalfeo/Crawler#3449 ("after killing the floor boss, the AI runner bounces
the door and can't leave or do anything").

## What Was Done

### Reproduction (before)

The run bundle/screenshot in the issue are unreachable from a sandboxed session
(no DNS), so the repro came from the headless pipeline instead. Seed 11 /
throwing-knife reproduces it exactly:

- Staircase boss dies at **210.5 s**; the run does not leave until **547.0 s** —
  **330 s** of standing at the exit.
- Instrumented probe (logged every 5 s from the unlock): the player orbits
  (924–931, 495–509) around a staircase at (934, 514) with `markerRadiusFt = 8`,
  alternating between `Heading to the stairs to clear the floor` and
  `Loot sweep: xp at distance 107–249 ft`, with the floor's loot counts frozen
  at 40 gems / 24 gold the entire time.

### Two stacked holds, both fixed

1. **Half-wired post-boss farm window** (added by PR #3276, diagnosed in
   `2026-08-23-floor1-post-boss-farm-stair-livelock.md`).
   `isFarmingPostBossFloorTime()` was consulted only in the _legacy_ Progress
   `take-stairs` branch — dead whenever `world.floorMap` exists, i.e. every real
   run — while `autoFloor1ProgressionSystem` honoured it and refused to confirm
   the descend. Deleted entirely: the module, the provider method, the optional
   `AIInputProvider` capability, the `postBossFarmReserveFraction` config knob
   and its three persona values, and the tests that covered only it. Making the
   window live in the goal graph instead was already measured as a win-rate
   regression (25/25 → 23/25) and is not revisited.

   Removing it alone took the exit latency 330 s → **285 s**, which is how the
   second (dominant) hold surfaced.

2. **Loot-sweep deferral charged only on-marker.** `shouldDeferStairDescend`
   holds the descend for `MAX_STAIR_DESCEND_DEFER_FRAMES` (1800 = 30 s) while
   loot remains, but it charged only frames _spent standing on the marker_. The
   provider's **pre-exit loot sweep is unbounded in range**
   (`buildLootSweepBehavior`, `maxDistance = Infinity` once the staircase is
   unlocked), so the AI kept walking back off the marker toward loot it never
   reached, and a 30 s hold stretched into minutes. The window is now anchored
   to the frame of the **first arrival** at the unlocked staircase, so wandering
   cannot extend it. The walk _to_ the stairs still never consumes it (the
   driver returns before the deferral check while out of radius).

### After

| metric (seed 11 · throwing-knife)              | before  | after       |
| ---------------------------------------------- | ------- | ----------- |
| staircase boss defeat → leave-floor completion | 330.0 s | **53.4 s**  |
| run length                                     | 547.0 s | **263.9 s** |

53.4 s = the 30 s sweep window plus one off-marker loot excursion before the AI
comes back to the (now free) exit.

### Coverage added

- `tests/headless/floor1-throwing-knife11-release-regression.test.ts` — asserts
  the post-boss exit latency from `RunStats`
  (`floor1BossProgression.encounters.staircase.encounterDefeatedMs` →
  `quests.questLogCompletions['floor1-leave-floor']`) against a 90 s deadlock
  ceiling. Verified failing at 330 s before the fix.
- `tests/game/auto-progression-npc.test.ts` — new unit regression that the
  deferral window closes on elapsed frames even when the AI leaves the marker;
  the removed farm-window block is replaced by "descends on arrival at the
  unlocked staircase".
- Note: `tests/headless/floor1-park-watchdog.test.ts` structurally could not see
  this class — its probes cap at 12 000 frames (~200 s) and the park begins
  after the boss dies (~210 s here).

## Gates re-measured

- `floor1-completion.test.ts` — green before **and** after (4/4, 25-seed panel).
- `floor1-economy-gate.test.ts`, `floor1-planning-deadline.test.ts` — rerun on
  this branch.
- Full `tests/unit` + `tests/game` (612 files / 9164 tests) — green.
- `typecheck`, `lint` — clean.

## Follow-ups / known gaps

- The provider-side oscillation itself is untouched: the pre-exit loot sweep can
  still target loot hundreds of feet away and lose the frame to Progress on the
  way, so the AI visibly bounces near the exit for up to ~50 s before leaving.
  That is now bounded and non-blocking, but a range/progress bound on the
  pre-exit sweep would remove the remaining wobble. It needs a broad sweep to
  land safely (it changes how much loot a run banks, which the economy gate
  measures), so it was deliberately kept out of this fix.
- ADR-0091 carries an amendment note: its "post-boss farming" tuning decision is
  removed; `calmFarmPullBoost` and every other decision in it stand.
