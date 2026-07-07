# ADR: Equip Items Directly From the Inventory Bag (Character-Screen Orchestration)

**Date:** 2026-07-06
**Scope:** src/shared (gear items + equipment defs), src/core (equip-from-bag orchestration on the equipment system), src/engine (InventoryUI equip gesture + tooltip hint, MainGameScene wiring)

## Status

Accepted

## Estimated Complexity

🍎 x 5 — no new ECS system, but the change threads a new "equip straight from
the bag" interaction across the shared/core/engine boundary: 15 new placeholder
gear items + equipment defs covering every non-weapon/non-neck paper-doll slot,
a new atomic swap orchestration in the core equipment system, a non-conflicting
double-click equip gesture layered onto the existing tooltip-pin contract, and
real-scene + lab wiring plus regression coverage.

## Context

The equipment paper-doll and the inventory bag were two disconnected surfaces.
`equip` / `unequip` in `src/core/systems/equipmentSystem.ts` operated purely on
equipment slots and had no notion of the inventory bag: a caller had to remove
the item from the bag, call `equip`, and hand-roll the return of whatever was
already in the slot. There was:

- **No player-facing way to equip an item that lives in the bag.** The UI could
  pin a tooltip but could not act on it, so "select gear to equip" — the whole
  point of a character screen — did not exist.
- **No content for most slots.** Only weapons (hand slots) and the merchant's
  charm (neck) had equippable defs, so 15 of the 18 paper-doll slots could never
  be filled and the grid could not be exercised end to end.
- **A gesture-collision risk.** A single click / tap already pins the item
  tooltip (an e2e-locked contract), so "click to equip" would have overloaded a
  gesture that already has a meaning.

We want the character screen to let a player pick an item out of their bag and
wear it, Diablo-style (equipping into an occupied slot swaps the old item back
to the bag), while keeping the equipment system the single authority over slot
state and keeping the panes intent-only.

## Decision

Add a bag-aware equip orchestration to the core equipment system and drive it
from the inventory pane through an explicit, non-conflicting gesture.

1. **`equipFromBag(world, entity, itemId, options?)` owns the swap, atomically.**
   It lives in `src/core/systems/equipmentSystem.ts` and performs a Diablo-style
   swap: every occupied target slot is force-unequipped back into the bag first
   (so the `occupiedSlot` guard never trips), the item is removed from the bag,
   then `equip` runs. On **any** failure it rolls back — re-adds the removed item
   and re-equips everything it swapped out — and returns the failure reasons. On
   success it returns the new `instanceId` and the ids of the items it swapped
   out so callers can surface "Unequipped X" feedback. It honors the same
   `isInSafeContext` gate as `equip` / `unequip` unless `options.force` is set
   (labs / tests / loadout). Internal equip/unequip calls are forced because the
   public gate is checked once up front.

2. **Panes stay intent-only; the scene is the mutator.** `InventoryUI` gains an
   `onEquipItem(itemId)` callback and a **double-click** equip gesture
   (`pointerdown`-based, `DOUBLE_CLICK_MS` window on `scene.time.now`). Single
   click / tap still pins the tooltip unchanged, so the existing e2e contract
   holds. The tooltip gains a footer hint advertising the equip gesture.
   `MainGameScene` wires `onEquipItem` to call `equipFromBag(this.world,
this.playerEid, itemId)` and, on success, refreshes both the inventory and
   equipment panes.

3. **Every slot gets equippable placeholder content.** 15 gear items are added to
   `src/shared/items.ts` with matching defs in `src/shared/equipmentDefs.ts`
   (`GEAR_EQUIPMENT_DEFS` / `GEAR_ITEM_IDS`), covering head, face, shoulders,
   chest, back, belt, legs, feet, gloves, both arms, both wrists, and both rings
   — the slots that had no content. Combined with weapons (hand slots) and the
   charm (neck) this makes all 18 `SLOT_REGISTRY` slots fillable. Each item is a
   placeholder rendered via the text fallback today and carries an art-plan entry
   (`plans/item-icons/equipment-gear.art.yaml`) so the sprite pipeline can author
   real icons later.

The gesture is deliberately **double-click** rather than single-click because
single-click is already the tooltip-pin gesture; overloading it would break the
pin contract and make "inspect" and "equip" ambiguous.

## Consequences

### Positive

- The character screen is now actionable: a player can equip anything in their
  bag, and the paper-doll reflects it immediately across both panes.
- The equipment system remains the single authority over slot state; the swap,
  the bag bookkeeping, and the rollback all live in one place instead of being
  reimplemented per caller.
- All 18 slots can be filled and exercised end to end, so the grid, stat
  aggregation, and inspector are validated against real content (observed: 18/18
  slots equipped via the real path, stats aggregated).

### Negative

- `equipFromBag` duplicates a small amount of bag/slot bookkeeping that also
  exists in `equip` / `unequip`; the orchestration is a thin layer on top rather
  than a merge of the three.
- The 15 gear items are placeholders (text fallback), so the paper-doll shows
  glyphs/labels rather than authored icons until the sprite pipeline runs.

### Risks

- The post-clear rollback branch (equip fails _after_ slots were cleared) is not
  reachable through the public API with current catalog data — no catalog def
  declares `requirements` and forced unequip always clears the slot. It is
  covered by reasoning and by the reachable atomicity branches; a future def with
  requirements must add a test for it rather than assume it is dead code.
- Double-click depends on the `pointerdown` timing window; a platform that
  coalesces or reorders pointer events could miss it. Mitigated by an e2e that
  drives `page.mouse.dblclick` against a seeded gear cell and asserts the slot
  fills.

## Alternatives Considered

- **Single-click to equip.** Rejected: single click already pins the tooltip (an
  e2e-locked contract). Overloading it makes inspect vs. equip ambiguous and
  breaks existing tests.
- **Let each caller remove-from-bag + equip + hand-return the old item.**
  Rejected: this is exactly the duplicated, drift-prone bookkeeping the weapon
  hand-slot ADR (2026-07-03) warned about; the swap and its rollback belong in
  one seam.
- **Ship the interaction with only weapon/charm content and no per-slot gear.**
  Rejected: 15 of 18 slots would remain permanently empty, so the grid, stat
  aggregation, and swap path could not be validated against real content.
- **Author real gear sprites now instead of placeholders.** Deferred: sprite
  authoring runs through the async art pipeline; placeholders with art-plan
  entries unblock the interaction today and let real icons land later without a
  code change.
