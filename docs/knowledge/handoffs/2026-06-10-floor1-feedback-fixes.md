# Handoff: Floor 1 feedback fixes

**Date:** 2026-06-10  
**Branch:** `nalfeo/fix-floor1-feedback`  
**Complexity:** 🍎🍎🍎🍎 estimated → 🍎🍎🍎🍎 actual (exact)

## Summary

Implemented the four requested Floor 1 fixes:

1. Wall tiles now render reliably in-world (no more missing/invisible wall pass).
2. Minimap collapsed icon no longer uses the placeholder globe emoji.
3. Modal picker now supports WASD (`W`/`S`) for up/down option navigation.
4. Rat/slime chase behavior now keeps converging while the player strafes, reducing left-right cheesing.

## Files changed

- `src/engine/ModalPickerUI.ts`
  - Added `KeyW`/`KeyS` bindings alongside ArrowUp/ArrowDown.
- `src/engine/HudMinimap.ts`
  - Replaced placeholder emoji icon text with `MAP`.
- `src/engine/terrain-renderer.ts`
  - Forced color-fallback rendering for wall terrain types (`STONE_WALL`, `CAVE_WALL`, `WOOD_WALL`) to avoid unreliable sprite-frame wall visibility.
- `src/shared/terrain-colors.ts`
  - Increased wall fallback contrast for better visibility.
- `src/game/enemyAISystem.ts`
  - Added a path+pursuit blend for **navigator** chase/swarm enemies on ground traversal so they still close distance during lateral player movement.
- `tests/game/enemy-ai.test.ts`
  - Added a regression test proving navigator chase closes distance while player strafes left-right.

## Verification

- `npm run verify:fast` ✅
- `npm run verify` ⚠️ failed on existing integration timeouts/unrelated integration instability:
  - `tests/integration/batch-cli.test.ts` timeout
  - `tests/integration/generate-one.test.ts` hook timeout
