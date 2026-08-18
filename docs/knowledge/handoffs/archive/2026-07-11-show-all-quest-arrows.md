# Handoff: Show All Quest Arrows

**Date:** 2026-07-11  
**Session:** show-all-quest-arrows  
**Estimated apples:** 🍎🍎  
**Actual apples:** 🍎🍎  
**Verdict:** exact

## Systems touched

quests, hud-ux

## What was done

- Changed `getQuestWaypoints` to return one waypoint for every visible active quest
  with a fixed directional target, rather than only the tracked quest.
- Added stable quest IDs to waypoint data so the HUD retains an independent arrow,
  label, and pulse tween for each quest.
- Added deterministic fan-out when quest targets point in nearly the same direction,
  keeping every arrow individually visible.
- Expanded the quest-waypoint lab to exercise three simultaneous active quests and
  expose the rendered quest IDs through a deterministic probe.
- Added ECS, pure layout, and browser regression coverage for multi-quest arrows and
  completed-quest filtering.
- Recorded the cross-layer boundary in ADR 0058: core resolves quest targets;
  engine owns screen-space layout and render-object lifecycle.

## Runtime observation

- Before: the real `MainGameScene` HUD rendered only the tracked quest's arrow.
- After: `tests/e2e/quest-waypoint-arrows.deterministic.test.ts` booted the real
  `MainGameScene` through the shipped Floor 1 bootstrap, and its live display list reported
  `floor1-find-welcome`, `floor1-shopkeeper-errand`, and
  `floor1-boss-battle` as three simultaneously visible arrow objects.

## Validation

- `npm run verify:fast`
- `npm run test:e2e -- tests/e2e/quest-waypoint-arrows.deterministic.test.ts`
- `VERIFY_FULL=1 npm run verify` — all 21 headless files / 92 tests passed;
  the initial run then surfaced the missing ADR prerequisite.
- `npm run verify` — final repository verification passed after ADR 0058.
