# 2026-07-16 quest-arrow-rendersale-fix

## Summary

Fixed the quest direction arrow showing when the target NPC is already visible on screen (issue #1179).

## Root cause

`HudDirectionArrows.sync()` passed `scene.cameras.main.zoom` directly to `resolveDirectionArrowStates()`.
The camera zoom is always `BASE_ZOOM * renderScale` (e.g. `2.0 * 2 = 4.0` on a HiDPI display).
`resolveDirectionArrowStates` uses `scale = PIXELS_PER_FOOT * zoom` to determine whether a waypoint's
target is on-screen in **design space**. With `zoom = 4`, `scale = 32` px/foot instead of the correct
`16` px/foot, so any target more than `(360 - SCREEN_MARGIN) / 32 = 8.75 ft` above the player was
incorrectly classed as off-screen. The Tutorial Goon is typically ~9 ft away, causing a spurious arrow.

## Fix

- `src/engine/HudDirectionArrows.ts` `sync()`: divide `camera.zoom` by `getRenderScale(scene)` before
  passing it to `resolveDirectionArrowStates`, so the on-screen check always uses design-space pixels.
- Added `getRenderScale` import from `./render-scale.js`.

## Tests

- Added regression test in `tests/unit/hud-direction-arrows.test.ts`: an NPC 9 ft above the player
  at `zoom=2` (BASE_ZOOM, the design-space zoom) must produce **no arrow**.

## Systems touched

hud, quest-waypoints
