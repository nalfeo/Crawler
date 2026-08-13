# Session Handoff: HUD UX Consistency — Saferoom Gate, Toggle-Close, Touch Dismiss

## Date

2026-07-13

## Persona

Engineer

## Systems touched

hud-ux, mobile-ux

## Apples

2🍎 estimated, 2🍎 actual (on estimate). No review-harness stages were required at this tier; ledger recorded in `docs/knowledge/review-ledgers/2026-07-13-hud-ux-consistency.review-ledger.json`.

## What changed

Closed three HUD UX inconsistencies filed in issue #1086:

### 1. All panels now close by hitting their shortcut key

- `[I]` inventory, `[G]` equipment, `[V]` achievements: already toggled correctly.
- `[B]` abilities: previously `isUiLockOpen()` (which includes `modalPicker.isOpen()`) blocked
  the close path — pressing `[B]` while the abilities modal was open did nothing.
  Fix: check `abilitiesToggleRequested && abilitiesOpen` **before** the `!isUiLockOpen()`
  guard, routing directly to `closeAbilitiesModal()`.

### 2. All panels have a touch-dismiss affordance

- Corner buttons (🎒 Bag, ⚔ Gear, 🏆 Awards) were hidden by `isBlockingSurfaceOpen()` when
  their own panel was open, leaving touch-only users unable to close them.
- Changed visibility to: show when **own** panel is open (dismiss path) **OR** when
  `canOpenNew` (no blocker, open path). Other panels' buttons hide when a different panel
  is open, keeping the UI uncluttered.
- Added `🔮 Skills` corner button with the same dismiss/open duality for the abilities modal.

### 3. All panels only openable in a saferoom

- `[B]` abilities: had no `safeCtx` check. Added guard and auto-close when the player leaves
  the saferoom while the modal is open.

## Key implementation details

- `abilitiesModalOpen: boolean` private field tracks whether the abilities config
  surface is active. `openAbilitiesConfigModal()` sets it before opening the live
  `abilityLoadoutUI`, and every close path resets it.
- `closeAbilitiesModal()` helper: safe no-op if not open, closes the live
  `abilityLoadoutUI` (or a legacy modalPicker fallback), then resets the flag and
  calls `updateOverlayText()`.
- `updateOverlayText()` transition block now includes `abilitiesButton` in the
  one-frame hide-all pass and keeps it at `MODAL_DISMISS_BUTTON_DEPTH` while the
  abilities surface is open.

## Files changed

- `src/engine/scenes/MainGameScene.ts`
- `tests/unit/main-game-scene-mobile-ui.test.ts`

## Validation

- Before (current-head repro from review recovery): `handleWindowKeyDown()` and the top-level
  `update()` early return stranded the `[B]` close path, and `updateOverlayText()`
  hid `abilitiesButton` under the abilities surface, so touch-only dismiss did not
  exist in the real scene.
- After: `npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts`
  boots the real `MainGameScene` through `main-scene-probe-lab` and observes the
  abilities surface open, `abilitiesButtonVisible === true` while it is open, `[B]`
  closing it, and a probe-emitted Skills-button tap dismissing it.
- `npm run verify:fast` — 1199 tests passed on the pre-fix baseline for the branch; rerun
  after the recovery fixes in this session.
