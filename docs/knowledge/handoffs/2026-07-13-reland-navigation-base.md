# Handoff: Reland navigation base UX slice

**Date:** 2026-07-13
**Session:** reland-navigation-base
**Apple estimate:** 🍎🍎🍎 (3)
**PR:** TBD (created this session)

## Systems touched

engine, hud

## Summary

Relanded the navigation base UX slice from durable ref `handoff/ux-navigation-base-20260713`
(commit `96bdf4dd`) onto current main. This was originally part of PR #1113 which was closed
due to CI recovery repeatedly combining separate slices.

## Changes

1. **`src/engine/navigation-hud-layout.ts`** (new) — Pure layout module computing responsive
   radar/quest positioning, critical HUD region reservations, and a `boundsOverlap` utility.

2. **`src/engine/HudMinimap.ts`** — Uses `resolveNavigationHudLayout` for radar dial
   positioning instead of local hardcoded constants. Close button uses separate X/Y margins.
   Panel hint updated to uppercase pixel-font style with pinch zoom discoverable.

3. **`src/engine/HudQuestTracker.ts`** — Complete rewrite using navigation layout module.
   Self-manages position/scale (no longer in a container group). Adds `fitQuestTrackerLines`
   for 32-char hard word-wrapping. BLUE_STEEL themed. `setVisible`/`getBounds` public API.
   Container sorted by depth for correct title-strip layering.

4. **`src/engine/HudUI.ts`** — Removed `topRight` container group. Quest tracker and
   direction arrows gated on map overlay state (hidden when fullscreen map open). Preserved:
   `computeVitalsScale` (#1116), `ABILITY_BAR_MAX_SCALE` (#1095), family fullscreen-map
   gating (#1118), ability bar/skill tracker from #1127.

5. **Tests** — New `hud-quest-tracker.test.ts` verifying wrapping + responsive layout
   collision-freedom. Updated `hud-minimap.test.ts` architectural guards for new layout
   approach.

## Valid findings incorporated

- ✅ Family-panel fullscreen suppression from #1118 preserved
- ✅ Hard-split overlong quest tokens with 32-char budget
- ✅ Quest title-strip layering below icon/text (root.sort('depth'))
- ✅ Pinch zoom discoverable in minimap guidance text
- ✅ Top-center/bottom-left critical reservations scale like HudUI
- ✅ Floor 2 tracker placed + capped to clear critical regions at scale 1 and 4/3
- ✅ Arrow labels/collision geometry NOT included (separate slice)

## Review notes

- Plan review (gpt-5.4): 3 concerns, all resolved. Floor 2 at 960×540 has a 22px corner
  overlap with the conservative top-center reservation — accepted as intentional (durable
  ref behavior; actual timer content doesn't fill reservation edges).
- Code review (claude-sonnet-4.6): 0 concerns, clean on round 1.
