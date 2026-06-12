# Session Handoff: Mobile UI Fixes — Inventory Buttons, Minimap Zoom, Quest Arrow

## Date

2026-06-12

## Apples

Estimated: 🍎🍎🍎🍎 (Large)
Actual: 🍎🍎🍎🍎
Verdict: 🎯 Exact — four problem areas × multiple files each; no ECS changes but meaningful HUD/scene coordination.

Hello kitties: 4/5 = 0.80 🎀

## Problem Statement

Four mobile UX issues reported by the user during in-device play:

1. **No inventory/equip button on mobile** — keyboard-only [I]/[G] bindings unusable on touch screens.
2. **Quest tracker + minimap overlap** — both HUD elements shared the top-right corner, obscuring each other; the Talk/Descend button was also too small to hit reliably.
3. **Rat tail quest — no pickup notification or guiding arrow** — player had no idea when the item was collected or where to take it.
4. **Minimap HUD shows the entire floor** (too zoomed-out); fullscreen map lacked mobile zoom controls.

## What Shipped

### `src/engine/HudQuestTracker.ts`

- Moved the tracker to sit **below the minimap** (`TOP_Y` 16 → 200, same right side) so the two elements no longer overlap.

### `src/engine/HudMinimap.ts`

- Added `HUD_MINIMAP_PLAYER_ZOOM = 3` constant.
- Rewrote `applyHudTransform()` to use **3× fixed zoom centred on the player tile**, clamped to map bounds; falls back to fit-to-view when player position is unknown.
- `sync()` now captures `lastPlayerTileX / lastPlayerTileY` from the ECS position store every frame so the widget scrolls with movement.
- Added `overlayZoomInBtn` (`+`) and `overlayZoomOutBtn` (`−`) text buttons inside the fullscreen overlay panel; both are wired to the same zoom logic as the keyboard `+`/`-` shortcuts and work on touch.
- Updated `panelHint` text to reflect the tap buttons.

### `src/engine/scenes/MainGameScene.ts`

- **`interactionHint`**: font `16px → 18px`, padding `{x:14,y:8} → {x:20,y:14}` for a larger tap target.
- **`inventoryButton`** (`[I] Pack`, bottom-right): shown when `featureUnlocks.inventory`; `pointerdown` toggles the inventory panel.
- **`equipButton`** (`[G] Equip`, above inventory button): shown when `featureUnlocks.equipment`; `pointerdown` triggers the equip action.
- **`questArrow`** (left-centre of screen): shows a rotating 8-direction compass character (`→ Merchant`, `↗ Merchant`, …) while the player holds the rat tail but has not yet purchased the charm; hides once the equipment unlock fires or the player is adjacent to the merchant.
- `updateFeatureUnlocks()`: shows/hides buttons; calls new `updateQuestArrow()`.
- Pickup notification changed from "Inventory unlocked! Press [I]…" → **"Rat Tail picked up! Follow the arrow to the merchant."**
- Equipment notification changed to reference the on-screen tap button.
- Full cleanup in the `shutdown` handler for the three new game objects.

### Tests

- `tests/unit/main-game-scene-mobile-ui.test.ts`: 2 new cases — mobile inventory/equip buttons, quest compass arrow.
- `tests/unit/hud-minimap.test.ts`: 1 new case — `HUD_MINIMAP_PLAYER_ZOOM`, `lastPlayerTileX/Y` tracking, and overlay zoom buttons.

## Test Results

- `npm run verify:fast` ✅ 1147 tests, all pass (3 new)
- `npm run verify` ⚠️ — same pre-existing `tests/integration/batch-cli.test.ts` timeout as before; all new tests pass.

## Key Decisions

- Quest arrow uses left-centre position so it doesn't conflict with the interaction hint (bottom-centre), health bar (bottom-left), or quest tracker (top-right). 8-direction compass arrows are sufficient resolution without needing a rotating Graphics object.
- Inventory/equip mobile buttons are bottom-right to mirror the health bar on the left and avoid the centred Talk/Descend hint.
- `applyHudTransform()` clamping ensures the 3× zoom never reveals black outside the map tiles even in corner rooms.
- Kept the fullscreen overlay drag-to-pan / pinch-to-zoom untouched; the new `+`/`−` buttons are additive.

## What's Next

- Validate on device: minimap 3× zoom, quest arrow direction, inventory/equip buttons, tap target size.
- Consider showing the quest arrow for _all_ pending quest objectives (not just the rat tail), using a more generic pointer component.
- The `questArrow` currently only points to the shopkeeper; if future quests need pointers, factor out into a `HudQuestPointer` component.

## Branch State

- Branch: `copilot/mobile-ui-fixes`
- All unit tests: ✅ pass
- PR created: no
