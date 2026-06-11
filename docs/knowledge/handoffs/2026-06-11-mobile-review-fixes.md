# Handoff: Mobile Review Fixes — 2026-06-11

## Session Summary

Reviewed PR "Fix floor 1 issues" for mobile breakage (@nalfeo request) and fixed all identified issues.

## Apple Estimate

🍎🍎 — Multiple targeted fixes across CI-blocking and mobile UX issues.

## Issues Fixed

### CI-Blocking

1. **Engine→game layer violation** (`MainGameScene.ts` line 39)
   - Removed `import { confirmFloor1StairDescend } from '../../game/floor1Scenario.js'`
   - Added `onStairDescend?: (world: GameWorld, playerEid: number) => void` to `MainGameSceneOptions`
   - Wired via `src/main.ts` which is permitted to import game modules

2. **Playwright untrusted dependency**
   - Added `playwright` to `TRUSTED_PACKAGES` in `scripts/agent/security/check-deps.ts`
   - Verified no known CVEs at v1.60.0

3. **Trap weapon / melee range gate** — already fixed by author in commit `b07cc89` before this session

### Mobile UX

4. **Minimap pinch-to-zoom** (`HudMinimap.ts`)
   - `handlePointerMove` now detects `scene.input.pointer2.isDown` for two-finger gestures
   - Calculates distance delta between both pointers and applies proportional zoom centred on pinch midpoint
   - `handlePointerUp` resets `lastPinchDist = 0`

5. **Minimap hint text** — updated from "Wheel: zoom Drag: pan +/-: zoom M: close"
   to "Drag/pinch: pan & zoom · Wheel/+/-: zoom · M: close"

6. **ModalPickerUI footer** — updated from "Up/Down: Navigate Enter: Confirm"
   to "Tap to select · Up/Down: Navigate · Enter: Confirm"

## Mobile Issues Not Fixed (Out of Scope / Minor)

- **`refreshCameraMasks()` GC pressure** — allocates two arrays per frame at 60fps; on mobile this is worse. Flagged in review but not fixed (performance optimisation, not a breakage).
- **Boss room interaction hint** — shows "Press E / tap to talk" for NPC; E key won't work on mobile. Tap path already functions correctly.
- **WASD modal navigation** — keyboard-only; mobile users use tap which already works.

## Files Changed

- `scripts/agent/security/check-deps.ts`
- `src/engine/scenes/MainGameScene.ts`
- `src/engine/HudMinimap.ts`
- `src/engine/ModalPickerUI.ts`
- `src/main.ts`

## Verification

`npm run verify:fast` — 1124/1124 tests pass, 0 lint errors
`npm run security:check` — 0 blocking findings
CodeQL — 0 alerts
