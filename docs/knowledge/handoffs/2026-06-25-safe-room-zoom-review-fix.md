# Handoff — Safe-room zoom review follow-up

**Date:** 2026-06-25
**Persona:** Producer (single-layer engine/rendering review fix)
**Apples:** estimated 🍎 / actual 🍎 (exact)

## Task

Address PR review feedback on the safe-room camera zoom delight feature.

## Change

- `src/engine/scenes/MainGameScene.ts`
  - Updated the safe-room zoom transition to call `camera.zoomTo(..., force=true)`.
  - This lets a rapid safe-room enter/leave transition interrupt an in-flight zoom tween and retarget immediately instead of getting stuck at the wrong zoom.

## Why this approach

`updateSafeRoomZoom()` already gates on safe-room state transitions, so the bug was not repeated tween restarts per frame; it was Phaser ignoring a second `zoomTo()` while the first zoom effect was still active. Passing `force=true` is the smallest fix because it preserves the existing transition gate and only changes the behavior when a new safe-room transition arrives mid-tween.

## Validation

- `npm run verify:fast`
- `npm run verify`
- `bash scripts/agent/lab-gate-check.sh`

## Follow-ups / notes

- `files/guard-telemetry.jsonl` was not present in this session, so no guard telemetry section was added.
