# Handoff — Safe-room camera zoom (delight feature)

**Date:** 2026-06-24
**Persona:** Producer (single-layer engine/rendering polish)
**Apples:** estimated 🍎 / actual 🍎 (exact)

## Task

Delight feature: when entering a safe room, zoom the camera 25% closer. Zoom
back out when leaving the safe room.

## Change

- `src/shared/constants.ts`
  - Added `CAMERA` constant (`BASE_ZOOM = 2.0`, `SAFE_ROOM_ZOOM_MULTIPLIER =
1.25`, `SAFE_ROOM_ZOOM_DURATION_MS = 400`).
  - Added pure helper `safeRoomCameraZoom(inSafeRoom)` → `BASE_ZOOM` or
    `BASE_ZOOM * 1.25`.
- `src/engine/scenes/MainGameScene.ts`
  - `setupCamera` now uses `CAMERA.BASE_ZOOM` and resets the new
    `cameraInSafeRoom` transition-tracking flag.
  - `updateCamera()` calls `updateSafeRoomZoom()`, which fires a smooth
    `cameras.main.zoomTo(...)` tween only on the enter/leave transition (reads
    `world.playerInSafeRoom`), so the tween is not restarted every frame.
- `tests/unit/constants.test.ts` — unit tests for `safeRoomCameraZoom`.

## Why this approach

`world.playerInSafeRoom` is already maintained every tick by `safeRoomSystem`
(`src/core/safe-space.ts`). The camera reacts to that flag in the rendering
layer, keeping core ECS pure and Phaser-free. Zoom math is a pure, unit-tested
helper in `shared`. No new ECS system was introduced, so no new lab is required;
`safeRoomSystem` remains covered by `safe-room-lab`.

## Validation

- `npm run verify` — full suite passes (typecheck, lint, format, 551 unit tests,
  integration, build).
- `bash scripts/agent/lab-gate-check.sh` — passes.
- Apple metrics: `docs/knowledge/metrics/apples/2026-06-24-safe-room-camera-zoom.json`
  (validated by apple-calibration).

## Follow-ups / notes

- The zoom uses Phaser's built-in `zoomTo` easing for the "delight" feel; the
  end-of-run `state === 'safe_room'` review screen is intentionally not affected
  (feature is scoped to physically entering/leaving a safe room during play).
