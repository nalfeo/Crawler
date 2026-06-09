# Handoff: Fix blurry tutorial modal text

**Date:** 2026-06-08  
**Branch:** `nalfeo/fix-blurry-tutorial-text`

## What was done

Fixed blurry text in the floor 1 tutorial / loadout modal (`ModalPickerUI.ts`).

**Root cause:** Phaser `Text` objects default to `resolution: 1`. On high-DPI
displays (`window.devicePixelRatio > 1`), this means the text canvas is
under-sampled and appears blurry when the browser upscales it.

**Fix:** Added a `crispText` helper (identical pattern to `InventoryUI.ts`) that:
1. Calls `.setResolution(Math.max(1, Math.round(window.devicePixelRatio || 1)))` on every `Text` node.
2. Wraps coordinates with `Math.round()` (`snap`) to avoid sub-pixel positioning.

All six `scene.add.text(...)` calls in `rerender()` were replaced with `crispText(...)`.

## Files changed

- `src/engine/ModalPickerUI.ts`

## Verification

`npm run verify:fast` passes (exit 0).
