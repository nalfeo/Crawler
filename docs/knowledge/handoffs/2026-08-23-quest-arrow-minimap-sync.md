# Handoff: Sync quest arrows across minimap and main HUD

**Date:** 2026-08-23  
**Session slug:** quest-arrow-minimap-sync  
**Apple estimate:** 2🍎  
**PR:** Closes #3313

## Systems touched

hud-ux, quests

## Problem

The Spell Broker quest arrow only appeared on the minimap/radar while the
merchant quest arrow only appeared on the main game screen. The HUD surfaces
were using different quest waypoint sources:

- Main-screen direction arrows used `getQuestWaypoints()`, so they rendered all
  active fixed-location quest waypoints.
- The minimap/radar used `getTrackedQuestWaypoint()`, so it rendered only the
  currently tracked quest.

When the Spell Broker quest became tracked, the radar showed only Spell Broker
while the merchant objective was still rendered by the main-screen arrows.

## Solution

Updated `HudMinimap` to consume `getQuestWaypoints()` and draw every active
quest waypoint on both minimap surfaces:

- fullscreen minimap dots and off-screen edge arrows;
- docked radar blips and edge arrows.

Existing single-arrow probe getters remain backward-compatible by returning the
first arrow state. New probe getters expose all active minimap/radar arrow states
so deterministic coverage can assert both quest IDs.

## Files changed

- `src/engine/HudMinimap.ts` — switched minimap waypoint source from tracked
  quest only to all active quest waypoints; added all-arrow probe state.
- `src/engine/HudUI.ts` — re-exported minimap all-arrow state accessors through
  the HUD facade.
- `src/labs/main-scene-probe-lab/index.ts` — added a real MainGameScene probe to
  activate merchant + Spell Broker quests together and read radar arrow IDs.
- `tests/e2e/helpers/main-scene-probe.ts` — added typed wrappers for the new
  probe methods.
- `tests/e2e/quest-waypoint-arrows.deterministic.test.ts` — added regression
  coverage that merchant and Spell Broker arrows appear on both the main game
  screen and minimap radar.

## Validation

- `npx tsc --noEmit --project tsconfig.json --pretty false`
- `npx vitest run --project e2e tests/e2e/quest-waypoint-arrows.deterministic.test.ts --reporter=dot`
- `npx vitest run --project e2e tests/e2e/minimap-overlay.test.ts --reporter=dot`
- `npx vitest run tests/ecs/questWaypoints.test.ts tests/unit/hud-direction-arrows.test.ts --reporter=dot`
- `npm run verify:fast`

The regression test exercises the real `MainGameScene` artifact via the
main-scene probe lab: before the fix, the radar path was wired to only the
tracked quest; after the fix, the probe observes both merchant and Spell Broker
quest IDs in the main-screen arrows and the minimap radar arrows.

## Notes

- The previous tracked-only minimap behavior was documented as an intentional
  clutter reduction in the 2026-07-25 quest-arrow handoff. Issue #3313
  supersedes that trade-off for active fixed-location quest waypoints so both
  HUD surfaces stay consistent.
- The issue screenshot/run bundle could not be downloaded in this sandbox
  because DNS resolution for `crawlersprites.blob.core.windows.net` failed.
