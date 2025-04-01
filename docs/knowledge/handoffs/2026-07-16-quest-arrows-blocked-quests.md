# Handoff: Hide Quest Arrows for Blocked Quest Objectives

**Date:** 2026-07-16  
**Session:** quest-arrows-blocked-quests  
**Estimated apples:** 🍎  
**Actual apples:** 🍎  
**Verdict:** exact

## Systems touched

quests, hud-ux

## What was done

- Added blocked-objective filtering in `getQuestWaypoints`
  (`src/core/systems/questWaypoints.ts`). When a quest's current active
  objective is a `goal` check for a flag that is the `onCompleteGoalFlag` of
  another still-active quest, the waypoint is suppressed. The blocker already
  has its own direction arrow, so showing a second arrow for the dependent
  quest is redundant and confusing.

  Specifically: `floor1-meet-npcs` tracks `floor1-shop-quest-complete` and
  `floor1-boss-battle-complete` as its two sequential objectives. While
  `floor1-shopkeeper-errand` or `floor1-boss-battle` are still active (they
  own those flags on completion), `floor1-meet-npcs` no longer emits a
  duplicate arrow.

- Precompute a `completionFlagOwner` map (goalFlag → questId) once per
  `getQuestWaypoints` call to keep the check O(n) not O(n²).

- Added four new unit tests in `tests/ecs/questWaypoints.test.ts`:
  - Shopkeeper-errand blocks meet-npcs while active.
  - meet-npcs waypoint returns once shopkeeper-errand completes.
  - Boss-battle blocks meet-npcs second objective while active.
  - Original test (meet-npcs alone, no blocker) still passes.

## Validation

- `npm run verify:fast` — 87 test files / 1200 tests passed.
- Existing e2e test (`quest-waypoint-arrows.deterministic.test.ts`) is
  unaffected: it only primes `floor1-find-welcome`, `floor1-shopkeeper-errand`,
  and `floor1-boss-battle` (no `floor1-meet-npcs`), so no arrow count changes.
