# Handoff: HUD Encounter Slice

**Date:** 2026-07-13
**Session:** hud-encounter-slice
**Apple estimate:** 🍎🍎🍎

## Systems touched

hud-ux

## Summary

Landed the encounter HUD stack layout — deterministic vertical positioning of boss bar and announcement banner in the top-center group, with probe bounds for overlap detection.

## Changes

- `src/engine/hud-encounter-layout.ts` — new pure-function module: `resolveEncounterStackLayout()` + `ellipsizeEncounterLabel()`
- `src/engine/HudBossBar.ts` — added `getLayoutBounds()` and `setTop()` for dynamic stacking
- `src/engine/HudAnnouncementBanner.ts` — added `getLayoutBounds()` and `setTop()`
- `src/engine/HudFloorTimer.ts` — added `getLayoutBounds()` for timer probe bounds
- `src/engine/HudUI.ts` — integrated encounter layout resolution in sync loop + `getEncounterProbeBounds()`
- `src/engine/pixel-ui.ts` — unified `BeveledPanel.getBounds()` to return `{x,y,width,height}` (was `Phaser.Geom.Rectangle`)
- `tests/unit/hud-encounter-layout.test.ts` — unit tests for layout module

## Deferred (follow-up slice)

- `src/engine/HudQuestTracker.ts` — `getLayoutBounds()` (9 lines, needed for full overlap probe)
- `src/labs/hud-lab/index.ts` — encounter lab integration
- `tests/e2e/hud-overlap-visual.test.ts` — zero-overlap deterministic e2e test
- `scripts/agent/review/setup/hud-encounter.js` — review setup utility

## Verification

- Typecheck: ✅ clean
- Lint: ✅ clean
- Unit test (hud-encounter-layout): ✅ passes (node version allows vitest)
- File count: 10 total (7 code + 3 governance)

## Stacking

Based on `nalfeo-hud-relationships-slice` (PR #1133, merged). Targets `nalfeo-feat-hud-reland-navigation-base` (PR #1131, open → main).
