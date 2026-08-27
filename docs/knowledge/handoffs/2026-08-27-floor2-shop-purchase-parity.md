# Session Handoff: Floor 2 shop stock ↔ purchase catalog parity (bowling ball)

## Date

2026-08-27

## Persona

Game Designer (economy/data plumbing)

## Systems touched

03-weapons, 07-drops-loot

## Apples

2🍎 estimated, 2🍎 actual

## What Was Done

Fixed issue #3693 ("why is bowling ball not purchasable"). Floor 2 shop stock was
validated only against `weapons.json` ids, while the authoritative purchase path
(`src/core/settlement-shop-purchase.ts`) required the id to resolve onto a bag
item (`items.ts` slug, or an equipment def whose `weaponId` matches). Weapons
that existed only in `weapons.json` therefore rendered with a name and price —
display name falls back to `getWeaponDef` — but refused the sale as
`unknown-item`. Five stocked ids were affected: `bowling-ball` (The Resource
Broker), `hammer` and `crossbow` (The Quartermaster), `knife` and `boomerang`
(The Fence).

Changes:

- Added inventory items and weapon-equipment defs for the five weapons, so a
  purchase lands in the bag (`addItem` requires an `ITEM_CATALOG` slug) and the
  equipped item activates its `WeaponDef`.
- Extracted the merchant stock resolution into `src/shared/shop-catalog.ts` and
  routed both the shop-archetype loader and the purchase path through it, so
  stock lists can only reference ids a player can actually buy. A future data
  typo now fails at load time instead of shipping an unbuyable row.
- Added `getEquipmentDefForWeaponId` (map lookup) replacing the per-call linear
  scan over every equippable id in the offer-view projection.
- Art-plan entries for the five new item icons (placeholder-tracked, like every
  other catalog weapon icon).

## Observation (before/after, real seeded stock)

Seeded Floor 2 stock via `planFloor2SettlementShops` (the real planner) for
seeds 1–8, projected through `getSettlementShopOfferViews`:

- Before: 26 offers with `canPurchase=false, reason=unknown-item`
  (`bowling-ball` ×4, `crossbow` ×7, `hammer` ×7, `knife` ×5, `boomerang` ×3).
- After: 0 blocked offers; purchasing `bowling-ball` credits the bag and the
  slug resolves to a weapon-equipment def.

## Key Decisions Made

Chose to make the stocked weapons real, purchasable items rather than deleting
them from the shop archetypes (which would have silently removed content) or
special-casing the bowling ball. Catalog-size and per-tag snapshot tests were
updated deliberately (118 → 123 items, Weapons 23 → 28).

## What's Next / Blockers

None. The five icons use tracked placeholders and can be generated through the
normal sprite pipeline whenever the art backlog reaches them.
