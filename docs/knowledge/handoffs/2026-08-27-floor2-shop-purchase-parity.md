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

- Added `ITEM_CATALOG` entries for the five weapons so a purchase lands in the
  bag (`addItem` requires an `ITEM_CATALOG` slug). Like the 14 pre-existing
  flavour weapons that ship with no `WEAPON_EQUIPMENT_DEFS` entry, they are
  catalog-only for now: wiring an equipment def requires real, approved art,
  and `check:equipment-art-coverage` (shrink-only ratchet, no per-entry escape
  hatch) fails any wired piece without it. Purchasable-but-not-yet-equippable
  is an existing, accepted pattern in this catalog — it is not a new
  compromise introduced by this fix.
- Extracted the merchant stock resolution into `src/shared/shop-catalog.ts` and
  routed both the shop-archetype loader and the purchase path through it, so a
  stock list can only reference an id the purchase path can actually resolve
  onto a bag item. A weapon id resolves through its equipment def when one
  exists (`sword` → `iron-sword`); otherwise a same-id `items.ts` catalog entry
  is used directly. A data typo now fails at load time instead of shipping a
  broken shop row.
- `getEquipmentDefForWeaponId` (map lookup) replaces the per-call linear scan
  over every equippable id in the offer-view projection.
- Art-plan entries for the five icons (`placeholderInUse: true`), tracked in
  the normal sprite backlog alongside the other flavour weapons.

## Observation (before/after, real seeded stock)

Seeded Floor 2 stock via `planFloor2SettlementShops` (the real planner) for
seeds 1–8, projected through `getSettlementShopOfferViews`:

- Before: 26 offers with `canPurchase=false, reason=unknown-item`
  (`bowling-ball` ×4, `crossbow` ×7, `hammer` ×7, `knife` ×5, `boomerang` ×3).
- After: 0 blocked offers. Purchasing `bowling-ball` debits gold, decrements
  stock, and adds the `bowling-ball` slug to the bag.

## Key Decisions Made

An earlier iteration of this fix pruned the five ids from the shop archetypes
entirely and tightened `resolveShopCatalogItem` to require an equipment def for
any weapon-tagged catalog item. Review correctly flagged that as re-shipping
the reported bug under a green test suite: the rows were gone, so "0 blocked
offers" was achieved by deleting the offers rather than making them
purchasable, and a player could no longer encounter the Bowling Ball at all.
Restored the rows, the catalog-only items, and the simpler resolver. The
equip-wiring gap (blocked by `check:equipment-art-coverage`) is the same
already-accepted state as the 14 pre-existing catalog-only flavour weapons, not
a new trade-off.

## What's Next / Blockers

The five icons use tracked placeholders and can be generated through the
normal sprite pipeline whenever the art backlog reaches them. Once real art
lands, the weapons can be promoted from catalog-only bag items to wired
equipment defs (`WEAPON_EQUIPMENT_DEFS`) so they activate their `WeaponDef` on
equip; wiring them before the art exists is blocked by
`check:equipment-art-coverage`.
