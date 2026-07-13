# Handoff: Floor 2 AI territory wiggle fix

**Date**: 2026-07-13  
**Session slug**: floor2-territory-wiggle-fix  
**Closes**: #1084  
**Apple estimate**: 🍎🍎 (2 apples)

## Systems touched

`ai-behavior-tree`

## Problem

Seed 42 Floor 2 AI runner got permanently stuck in EXPLORE state, wiggling against the
imps territory door at world position (590, 386). Two interacting bugs created a deadlock:

1. **EXPLORE no-path wiggle**: When `moveToward` called `findTilePath` for an EXPLORE
   target and got an empty path, execution fell through to `moveWithLocalNavigation`.
   This caused ~8ft oscillation that repeatedly reset the `DwellTracker` escape circle
   (`EXPLORE_DWELL_ESCAPE_FT = 8`), preventing the watchdog from ever firing and
   suppressing the goal.

2. **Floor 2 bypassing suppression gate**: Even when the DwellTracker did eventually
   fire and set `progressGoalSuppressedUntilFrame`, the Floor 2 den quest path inside
   `findFloor2ProgressObjective` executed _before_ the suppression check and never saw
   the `progressSuppressed` variable. The territory target was re-assigned every frame.

## Fixes

### Fix 1 — `moveToward` EXPLORE no-path handler (`src/game/ai/bt-ai-provider.ts`)

After `findTilePath` returns an empty path (`path.length <= 1`), when
`this.decision.state === AIState.EXPLORE`:

- Clear `decision.targetX = null`, `decision.targetY = null`
- Set `state.moveX = 0`, `state.moveY = 0`
- `return` early

This mirrors the existing COLLECT treatment (which blacklists the loot eid). Stopping
movement lets the DwellTracker accumulate toward the 180-frame limit reliably.

### Fix 2 — `findFloor2QuestProgressTarget` suppression gate (`src/game/ai/bt-ai-provider.ts`)

Added required `progressSuppressed: boolean` parameter (no default, so all callers must
be explicit). In the `'counter'` case, the territory fallback now returns
`progressSuppressed ? null : territoryTarget` for both the pre-unlock path and the
post-unlock fallback. The call site in `findFloor2ProgressObjective` passes
`world.frameCount < this.progressGoalSuppressedUntilFrame`.

Entity-based targets (`familyEnemy`, `bossTarget`) are intentionally _not_ suppressed —
only the fixed-position territory sweep is gated.

## How the two-bug deadlock works together

- Fix 1 alone: target cleared → DwellTracker fires reliably → suppression set →
  **without Fix 2**: Floor 2 still ignores suppression → territory re-assigned
- Fix 2 alone: suppression checked → but wiggling still defeats DwellTracker first
- Both fixes: A\* fails → target cleared + no movement → DwellTracker fires in ≤180
  frames → suppression set for 360 frames → Floor 2 NOW skips territory → AI explores
  elsewhere

## Tests added

`tests/game/behavior-tree-ai.test.ts`:

- `'clears EXPLORE target and stops movement when A* finds no path (Floor 2 staircase
behind wall)'` — seals a map at wall column 14, places staircase at tile (22, 8) —
  exactly 8 tiles past the wall so `resolveReachableGoalTile`'s 6-tile ring search finds
  no reachable fallback. Verifies `decision.targetX === null` and `input.moveX === 0`.
- `'does not re-target Floor 2 territory when progressGoalSuppressedUntilFrame is in
the future'` — calls `initializeFloor2Scenario`, marks prerequisites, injects
  `progressGoalSuppressedUntilFrame = Number.MAX_SAFE_INTEGER` via private cast, and
  asserts `decision.reason` does not match `/territory/i`.
- `'does not re-target Floor 2 staircase progress when progressGoalSuppressedUntilFrame
is in the future'` — sets an unreachable staircase objective behind a sealed wall,
  forces suppression active, polls 8 frames, and asserts the decision reason never
  reverts to `"Heading to the Floor 2 exit stairs"`.

## Observe-before-done evidence (real headless pipeline)

- **Before fix** (detached pre-fix commit `671f88e`):
  - `npm run ai:headless -- --seed 42 --weapon sword --floor floor2 --json`
  - Result: `Outcome: STALLED` with `Stall: quest progress frozen for 360s`, `Final Level: 6`, `Kills: 67`, `Game Time: 896.1s`.
- **After fix** (current head):
  - `npm run ai:headless -- --seed 42 --weapon sword --floor floor2 --json`
  - Result: no stall classification (`Outcome: TIMEOUT`), with `Final Level: 12`, `Kills: 327`, `Game Time: 1200.0s`.

This demonstrates the seed-42 run no longer gets trapped in the prior stalled
progress signature and instead continues active progression/combat for the full run window.

## Review ledger

- `docs/knowledge/review-ledgers/2026-07-13-floor2-territory-wiggle-fix.review-ledger.json`

## Key implementation notes

- `resolveReachableGoalTile` uses a ring search up to `PATH_GOAL_SEARCH_RADIUS_TILES = 6`
  tiles. The test places the goal > 6 tiles from the wall so the ring never finds a
  reachable left-side fallback tile, ensuring A\* gets the unreachable raw goal.
- `moveToward` returning early does NOT bypass the Track B blend or smoothing — those
  run after the call returns. With no enemies/loot, the blend is zero, so `input.moveX`
  stays 0.
- The parameter change from `progressSuppressed: boolean = false` to `progressSuppressed:
boolean` (required) catches any future call site that forgets to pass it.
