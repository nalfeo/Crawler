# Handoff — Gear/Items UX in Snapshot + Gold Coin Art

**Date:** 2026-06-27
**Session:** gear-items-ux-snapshot-gold-coins
**Persona:** UX Designer / Systems Engineer (two-layer change)
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** 🎯 exact

## Why

Two gaps identified by the operator:

1. **ux-snapshot-lab missing gear/items panels** — the UX snapshot covered HUD, dialogue, and modal but not `InventoryUI` or `EquipmentUI`, so those panels couldn't be eyeballed or iterated from the single snapshot screen.
2. **Gold coin drops had bad art/animation** — in the real game, dropped `Gold` entities fell through to the `'default'` entity type which renders as a white pill (TEX_BULLET). No bobbing animation, no shadow, nothing coin-like.

## What Was Done

### 1. Gold coin rendering (`src/engine/PhaserBridge.ts`)

- **Imported `Gold` component** from `core/components.ts`.
- **Added `TEX_GOLD = '__cw_gold'`** constant.
- **Generated a 16×16 gold coin texture** in `generateTextures()`: dark outer ring (`0x6b4a08`) → golden disc (`0xffd24a`) → darker highlight (`0xd79320`) → light sparkle pixel (`0xfff4c2`). Same approach as the XP gem procedural texture.
- **Added `'gold'` to `getEntityType()`** — checked after `XpGem` so gold drops resolve before falling through to `'default'`.
- **Added `'gold'` to `getProceduralTextureForType()`** — returns `TEX_GOLD`.
- **Added `goldSpawnMs` and `goldShadows` maps** alongside the existing gem equivalents.
- **Added `case 'gold':` in the per-type switch** inside `sync()`: bobbing sine animation (slightly faster period + smaller amplitude than gems so coins feel lighter), ground shadow ellipse (14×5 px, 0.25 alpha), per-eid phase offset using `eid % 11` to desync nearby coins.
- **Added cleanup loops** for `goldShadows`/`goldSpawnMs` in both the entity-removal loop and `destroy()`.

### 2. Gear and Items UX in snapshot (`src/labs/ux-snapshot-lab/index.ts`)

- **Updated doc comment** to mention InventoryUI and EquipmentUI.
- **Imported** `createInventoryUI`, `createEquipmentUI`, `addItem`, and `SHOPKEEPER_EQUIPMENT_ITEM_ID`.
- **Extended `UxLabSettings`** with `showInventory` and `showEquipment` booleans (start `false`).
- **Updated hint text** to mention `[I]` / `[G]` keyboard shortcuts.
- **Added `inventoryUI` and `equipmentUI` instance variables** in the outer closure.
- **In `create()`:**
  - Set `world.featureUnlocks.inventory = true` and `world.featureUnlocks.equipment = true`.
  - Set `world.playerInSafeRoom = true` so panels open without safe-room restriction.
  - Seeded the player bag: `merchants-stained-charm` (equippable), `iron-ore ×3`, `copper-ore ×2`, `ectoplasm-glob ×4`, `health-vial ×1`.
  - Instantiated both UIs immediately after `createHudUI`.
  - Added `keydown` handler: `[I]` → `inventoryUI.toggle()`, `[G]` → `equipmentUI.toggle()`.
- **In `update()`:** calls `inventoryUI.refresh()` and `equipmentUI.refresh()` while the panel is open so live stat sliders reflect immediately.
- **In shutdown:** destroys both UIs and removes the keydown listener.
- **Added two GUI controls:** "Toggle inventory [I]" and "Toggle equipment [G]" buttons so the panels are reachable from the controls panel without a keyboard.
- **Updated `registerLab` description** to include the two new panels.

## Files Changed

| File                                | Change                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `src/engine/PhaserBridge.ts`        | Gold entity type, procedural coin texture, bobbing animation + shadow, cleanup |
| `src/labs/ux-snapshot-lab/index.ts` | InventoryUI + EquipmentUI, inventory seeding, keyboard shortcuts, GUI controls |

## Validation

- `npm run typecheck` ✓
- `npm run lint` ✓
- `npm run verify:fast` ✓ (17/17 unit tests, including existing phaser-bridge gem tests)
- `bash scripts/agent/lab-gate-check.sh` ✓
- No `files/guard-telemetry.jsonl` events.

## Notes for Next Agent

- Gold drops now render as a 16×16 gold coin with bobbing and shadow in both the real game and any lab using `createPhaserBridge`. No Kenney sprite mapping was added (there is no coin sprite in the current registry); the procedural texture is the canonical fallback and matches the quality bar of other procedural textures.
- The ux-snapshot-lab's inventory bag is pre-seeded with representative items. To add more equippable item types to the equipment panel demo, add entries to `EQUIPMENT_BY_ITEM_ID` in `src/shared/equipmentDefs.ts` and seed those IDs in the lab's bag.
- `world.playerInSafeRoom = true` is the gate for opening inventory/equipment UIs. The lab sets this unconditionally so all panels are always accessible during iteration.

## Apples

Estimated 🍎🍎, actual 🍎🍎 (exact). Two focused files, both following existing patterns (gem bob/shadow → gold bob/shadow; HudUI → InventoryUI + EquipmentUI). No new ECS systems, no new labs required, no ADR.

## Systems touched

inventory
