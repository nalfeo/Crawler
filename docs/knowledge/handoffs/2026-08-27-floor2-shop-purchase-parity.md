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

- Extracted the merchant stock resolution into `src/shared/shop-catalog.ts` and
  routed both the shop-archetype loader and the purchase path through it, so
  stock lists can only reference ids a player can actually buy _and equip_. A
  weapon id resolves through the equipment def that activates it; a
  weapon-tagged catalog item is rejected unless it carries an equipment def of
  its own. Both a data typo and an inert-weapon sale now fail at load time
  instead of shipping a broken shop row.
- Pruned the five ids from `shop-archetypes.floor2.json`. They cannot be made
  sellable yet: a purchase must land an equippable item, an equippable item
  needs a `WEAPON_EQUIPMENT_DEFS` entry, and `check:equipment-art-coverage`
  (shrink-only ratchet, no per-entry escape hatch) fails any wired equipment
  without real approved art — none of the five have any. Selling them as
  catalog-only bag items was tried and rejected in review: `isEquippableItem`
  is false for them, so `InventoryUI` offers no equip action, `floorScenario`
  auto-equip skips them, and `equipmentSystem` never activates the `WeaponDef`
  — the sale would be a pure gold trap.
- Added `getEquipmentDefForWeaponId` (map lookup) replacing the per-call linear
  scan over every equippable id in the offer-view projection.
- Art-plan entries for the five icons, so the art that unblocks re-stocking them
  is tracked in the normal sprite backlog.

## Observation (before/after, real seeded stock)

Seeded Floor 2 stock via `planFloor2SettlementShops` (the real planner) for
seeds 1–8, projected through `getSettlementShopOfferViews`:

- Before: 26 offers with `canPurchase=false, reason=unknown-item`
  (`bowling-ball` ×4, `crossbow` ×7, `hammer` ×7, `knife` ×5, `boomerang` ×3).
- After: 0 blocked offers. Every one of the 10 ids a shop may now stock resolves
  to a bag item with a live equipment def (`sword`→`iron-sword`,
  `bow`→`frost-bow`, `pistol`→`plasma-pistol`, `baseball-bat`→`bone-club`,
  plus `throwing-knife`, `landmine`, `fireball`, `laser`, `punch`,
  `merchants-stained-charm`).

## Key Decisions Made

Reviewer + an independent model both flagged the first attempt (add catalog
items so the sale lands) as a worse bug than the one being fixed: it made the
Bowling Ball buyable but permanently unequippable. With the art ratchet blocking
the equipment def, the only remedies were "sell a gold trap" or "stop
advertising it until art lands"; chose the latter and made the loader enforce it
so the class of bug cannot recur.

Content cost, for the human to weigh: The Resource Broker is down to 2 stock
entries (`merchants-stained-charm`, `throwing-knife`) and so always rolls the
same two, and The Quartermaster is down to 3 (min 3). Landing the five icons
restores the variety; substituting other weapons in the meantime is a balance
call, not a bug fix, so it was left alone.

## What's Next / Blockers

Generate the five weapon icons (`plans/item-icons/weapons.art.yaml`), then
re-land in one atomic change: `ITEM_CATALOG` entries + `WEAPON_EQUIPMENT_DEFS`
entries + the `shop-archetypes.floor2.json` stock rows. The load-time guard will
accept them the moment the equipment defs exist, and `check:equipment-art-coverage`
will accept the equipment defs the moment the art does.
