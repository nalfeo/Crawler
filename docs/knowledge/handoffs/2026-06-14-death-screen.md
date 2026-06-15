# Handoff: Player Death System — 2026-06-14

## Session Summary

Implemented the "player has died" death system. The `healthSystem` already set
`world.state = 'game_over'` when the player's HP reached zero, but no UI
appeared. This session added the missing engine layer.

## Apple Estimate

- Declared: 🍎🍎🍎 (Medium)
- Actual: 🍎🍎🍎
- Verdict: **on-estimate**. New engine UI component, scene wiring, new lab,
  lab registration — ~4 files, clean scope.

## What Shipped (PR #127)

### `src/engine/GameOverUI.ts` (new)

- Wraps `ModalPickerUI` with two options: **↺ Restart** and **← Quit**.
- `GameOverUIHooks` interface (`onRestart`, `onQuit`) injected from the scene.
- Option IDs checked explicitly so future additions don't accidentally fall
  through to `onQuit`.
- Designed for extensibility: more options (resurrect, god deal) can be pushed
  into the options array without changing display logic.

### `src/engine/scenes/MainGameScene.ts`

- New private fields: `gameOverUI` + `deathScreenShown` latch.
- `create()`: initialises `GameOverUI`; both hooks call `window.location.reload()`
  (TODO comment marks where title-screen navigation goes later).
- `showDeathScreenIfNeeded()`: fires once when `world.state === 'game_over'`
  AND `getFloorRunOutcome() === null` (floor-completion screens take precedence,
  documented in JSDoc).
- Called from `update()` right after `showFloorCompletionScreenIfNeeded()`.
- `shutdown` handler: destroys and clears `gameOverUI`.

### `src/labs/death-lab/index.ts` (new)

- DOM lab (`?lab=death-lab`) simulating the `playing → dying → game_over`
  transition with the Game Over modal in isolation.
- Auto-runs on load; lil-gui exposes dying-delay knob + kill/reset buttons.

### `src/lab-main.ts`

- `death-lab` registered in `LAB_MODULE_PATHS`.

## Known Gaps / Future Work

- `onQuit` and `onRestart` both do `window.location.reload()` — once a title
  screen or scene-restart API exists, differentiate them.
- Future options: "Resurrect with penalty" (`onResurrect` hook), "A god offers
  a deal…" (`onGodDeal` hook) — add to `GameOverUIHooks` + push new entries
  into the options array in `GameOverUI.ts`.
- The death screen currently has no kill-cause message (e.g. "Slain by
  Rat-Slime Hybrid"). Once combat events carry attacker info, plumb that into
  the subtitle.

## Verification

- `npm run verify:fast` — 1144/1144 tests pass ✅
- `bash scripts/agent/lab-gate-check.sh` — all systems covered ✅
- CodeQL: 0 alerts ✅
