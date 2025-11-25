# Gore Lab — Real Sprites

**Date:** 2026-06-27
**Branch:** `nalfeo-gore-lab-real-sprites`
**Persona:** Producer (small lab-wiring fix)
**Apple estimate:** 🍎🍎 → **Actual: 🍎🍎** (matches)

## Systems touched

devtools, enemies

## Summary

The gore lab was rendering procedural green/orange diamonds for player and enemy because `GoreLabScene` never preloaded the Kenney sprite sheets the main game loads via `BootScene`. That made the gore VFX visually unjudgeable, since `CorpseShatterVfx` cuts up whatever texture the live enemy sprite is using — a 24x24 procedural square in the fallback path.

Fixed by mirroring `BootScene`'s critical-sheet preload directly inside `GoreLabScene`, plus warming the generated-sprite manifest the same way `inventory-lab` does, plus enabling `pixelArt`/`roundPixels` so the sprites stay crisp.

## Files touched

- `src/labs/gore-lab/index.ts` — added `preload()` for the four critical sheets, async `warmGeneratedSprites()` after `create()`, `pixelArt: true` + `roundPixels: true` on the Phaser config, and a `CRITICAL_SHEET_KEYS` constant + new imports.

No other files changed. Lab-only wiring; no system or core changes.

## Verification

- `npm run verify:fast` — green (typecheck + lint + unit tests).
- Headless visual check: launched `npm run lab`, navigated to `/lab.html?lab=gore-lab` via Playwright/Chromium, screenshotted the canvas. Confirmed the skeleton-style player sprite and orange creature enemy sprite render in place of the procedural diamonds. Screenshot saved to session-state `files/gore-lab.png`.

## Unresolved / follow-ups

- Headless keyboard input into the Phaser canvas didn't reliably trigger weapon auto-fire from my driver script, so the gore-event counter screenshot wasn't captured. The path is still exercised by the real game today; the gore lab change doesn't affect the gore pipeline itself, only what textures it draws against. A future improvement would be adding a "force-fire" GUI button to the lab to make headless verification deterministic.
- The other Phaser-based labs (`inventory-lab`, etc.) skip the Kenney sheet preload too. If any of them grow to rely on entity sprite rendering, they'll hit the same fallback. Could be worth a shared `preloadCriticalSheets(scene)` helper.

## Recommended next steps

- Merge and move on. If we want stronger regression protection, add a deterministic headless test that loads the gore lab and asserts `scene.textures.exists('kenney-tiny-dungeon')` returns true.
