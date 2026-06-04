# Handoff: Inventory System

**Date:** 2026-06-03
**Branch:** `nalfeo/inventory-system-design`
**Status:** Complete, all tests passing (152/152), lint clean, typecheck clean

## What was done

Built a full inventory system across all layers:

### New files
- `src/shared/items.ts` — Item data model with `KnownTag | CustomTag` system and 100-item catalog
- `src/shared/inventory.ts` — Pure inventory manager (add/remove/stack/search/sort/filter/tabs)
- `src/core/systems/itemPickupSystem.ts` — Auto-pickup on Player↔DroppedItem collision
- `src/engine/InventoryUI.ts` — Phaser overlay panel with dynamic tabs, search, tooltips
- `src/labs/inventory-lab/` — Lab for iterating on inventory UX
- `tests/ecs/itemPickupSystem.test.ts` — 6 pickup system tests
- `tests/unit/inventory.test.ts` — 33 inventory manager tests
- `tests/unit/items.test.ts` — 17 catalog validation tests

### Modified files
- `src/core/components.ts` — Added `Inventory` tag, `DroppedItem` store (`itemIndex`)
- `src/core/world.ts` — Added `inventories: Map<number, InventoryBag>` to GameWorld
- `src/core/helpers.ts` — Added `spawnDroppedItem`, updated `spawnPlayer` with Inventory
- Various `index.ts` barrel files updated

## Key design decisions

1. **Dynamic tag system** — No fixed category enum. Items carry `tags: ItemTag[]` where `ItemTag = KnownTag | CustomTag`. Tabs appear only when player holds matching items.
2. **TabPreferences** — Users can reorder all tabs and hide custom tabs. Canonical 5 tags cannot be hidden.
3. **Side-car inventory** — `GameWorld.inventories` Map (eid → InventoryBag) because bitecs typed arrays can't hold variable-length collections.
4. **Branded CustomTag** — AI can generate novel tags at runtime without type changes.

## Next steps

- Wire inventory UI into MainGameScene (currently only in the lab)
- Integrate with crafting system when ready
- Add item use/consume actions
- Replace text icons with actual sprite assets
- Consider ADR for the tag system design
