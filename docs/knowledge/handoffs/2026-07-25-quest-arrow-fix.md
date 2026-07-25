# Handoff: Fix quest arrow bouncing and add minimap edge arrows

**Date:** 2026-07-25  
**Session slug:** quest-arrow-fix  
**Apple estimate:** 3🍎  
**PR:** Closes #1936

## Systems touched

hud-ux, quests

## Problem

Quest guide arrows were bouncing from side to side of the screen as the player moved. The root cause was the arrows being positioned on an **ellipse** formula (`CX + cos(angle)*RX, CY + sin(angle)*RY`). The ellipse produces arrow positions that float at intermediate screen locations, causing apparent side-switching as the target angle changes during player movement.

Additionally, neither the docked radar dial nor the full-screen overlay minimap had any indication of off-screen quest waypoints.

## Solution

### 1. Screen arrows — rectangle-edge intersection

Added `rectEdgePt(angle)` helper in `HudDirectionArrows.ts` that projects a direction angle onto the rectangular inset boundary using the formula:
- `t = min(RX/|cos|, RY/|sin|)`
- Returns `(CX + cos*t, CY + sin*t)`

This pins each arrow to exactly one screen edge (right/top/left/bottom). Small angle variations near horizontal produce small y-variations along the same edge, not jumps between sides. The same RX/RY constants are preserved (RX=544, RY=264 for a 1280×720 screen with 96px inset).

### 2. Radar dial edge arrows

When the quest waypoint is outside the radar dial circle, a small gold triangle is drawn at the dial rim pointing toward the waypoint. Rendered into `radarScratch` (composited into `radarRt`). Constants: `RADAR_EDGE_ARROW_SIZE=3`, `RADAR_EDGE_ARROW_INSET=10`.

### 3. Overlay edge arrows

Added `overlayArrowGraphics` (screen-space Graphics object, `HUD_DEPTH+5`) and `drawOverlayArrows()` in `HudMinimap.ts`. When the full-screen overlay is open and the waypoint's tile position (converted to screen space via `viewState`) is outside the viewport, a triangle arrow is drawn at the viewport edge. Uses the same rectangle-edge intersection formula as the screen arrows, but operating against viewport dimensions with `OVERLAY_EDGE_ARROW_SIZE=6` and `OVERLAY_EDGE_ARROW_INSET=10`.

**Key inset math:** the inset is applied to the rectangle half-extents (`vRX = viewport.width/2 - OVERLAY_EDGE_ARROW_INSET`) rather than subtracted from `t`. This ensures the arrow tip sits a fixed perpendicular distance from the edge regardless of approach angle.

## Files changed

- `src/engine/HudDirectionArrows.ts` — Added `rectEdgePt()`, changed `resolveDirectionArrowStates` to use rectangle-edge intersection
- `src/engine/HudMinimap.ts` — Added radar edge arrows, `overlayArrowGraphics`, `drawOverlayArrows()`, visibility management
- `src/engine/HudUI.ts` — Exposed live overlay viewport bounds through the HUD navigation probe
- `src/labs/ux-snapshot-lab/index.ts` — Added a lab-only minimap probe seam for deterministic waypoint placement in e2e
- `tests/unit/hud-direction-arrows.test.ts` — Added same-edge crowding coverage plus rectangle-edge regression tests
- `tests/e2e/minimap-overlay.test.ts` — Added radar/overlay waypoint-arrow pixel assertions and overlay zoom/pan visibility transitions

## Tests

Added:
- `keeps an arrow on the same screen edge when the target angle varies slightly` — regression for the bouncing bug
- `keeps crowded right-side arrows pinned to the right edge through later fan attempts` — regression for collision-avoidance reselecting the wrong edge
- `pins arrows to the nearest screen edge not an intermediate ellipse position` — verifies 45° goes to bottom edge
- `places axial directions exactly on the correct screen edge` — verifies straight up/down/left/right hit their exact edges
- `shows and hides the overlay edge arrow as zoom/pan move a tracked waypoint off-screen` — verifies overlay arrow visibility transitions in the real Phaser HUD
- `draws a radar edge arrow only while the tracked waypoint is outside the dial` — verifies the docked radar arrow appears only for off-dial waypoints

## Product decisions

- **Minimap shows only the tracked waypoint** (single primary objective, same as `getTrackedQuestWaypoint`). Main screen HUD arrows show all active waypoints via `getQuestWaypoints`. This is intentional — showing multiple minimap arrows for stacked objectives would clutter a small radar dial.

## Known gaps

- Local validation in this recovery session depended on a clean `npm ci`, but the sandbox could not fetch lockfile tarballs from `ms-feed-2.pkgs.visualstudio.com` (`ENOTFOUND`). The new minimap and arrow coverage is present in-tree; CI is the first full runner that can execute it end-to-end from this session.

## Review

- Plan review: gpt-5.4, 4 concerns, 4 resolved. Divergence: `minor` (overlay inset math fixed).
- Code review round 1: claude-opus-4.8, 0 concerns. Clean.
- Ledger: `docs/knowledge/review-ledgers/2026-07-25-quest-arrow-fix.review-ledger.json`
