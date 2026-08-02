# Handoff: Loading screen with progress bar

## Summary

Added a styled loading screen with animated progress bar shown during two moments:

1. **Initial game boot** (`BootScene`) — shown while critical sprite sheets and terrain pack textures load. Progress maps Phaser's built-in loader events (0→80%) then the async generated-sprites phase (80→100%). Uses `'fileprogress'` events to display the current file name.

2. **Floor-to-floor transition** (`MainGameScene`) — the existing "Floor 1 Complete!" overlay now includes an animated progress bar that fills from 0→100% over 1.3 s before triggering `scene.restart()`. Only shown for the floor transition case; other outcomes (game over, victory) show the completion panel without a bar.

## Files touched

- `src/engine/scenes/BootScene.ts` — loading screen UI in `preload()`, progress cleanup in `loadGeneratedSpritesAndStartGame()`
- `src/engine/scenes/MainGameScene.ts` — module constants `FLOOR_TRANS_BAR_*`, 4 new private fields, `startFloorTransitionProgress()` method, extended `floorCompletionScreen` container, destroy call in shutdown handler

## Key design decisions

- No new Phaser scene — loading UI is inline in BootScene using Phaser's standard `preload()` lifecycle
- `'progress'` / `'fileprogress'` listeners removed with `load.off()` before the generated-sprites cycle to prevent them from fighting with the `FILE_COMPLETE` counter
- `FILE_LOAD_ERROR` counted alongside `FILE_COMPLETE` so the bar advances even when individual generated sprites fail
- Floor transition bar uses a tween on `{value: 0}` with `onUpdate` to avoid tweening Rectangle internals directly

## Verification

- Reviewed by rubber-duck agent (claude-sonnet-4.6) for plan bugs; 3 issues found and fixed
- Code review passed (claude-opus-4.6, round 1, 0 concerns)
- CI will validate compilation; local deps unavailable in sandbox

## Apples

Estimated: 🍎🍎🍎 | Actual: 🍎🍎🍎

## Systems touched

engine-scenes
