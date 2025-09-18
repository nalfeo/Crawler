# Handoff: Surveyor Map Sprite — Issue #1389

**Date:** 2026-07-18  
**Session:** copilot/asset-request-surveyor-map  
**Apple estimate:** 1🍎 art lane, 2🍎 wiring (ledger-exempt at 2🍎)  
**Closes:** nalfeo/Crawler#1389 (aggregate: nalfeo/Crawler#1303)

---

## Summary

Scaffolded the `surveyor-map` Floor 2 accessory icon asset and wired the sprite
resolution path so the inventory/equipment UI renders the real art automatically once
the cloud pipeline delivers it.

---

## Systems touched

- `briefs/items/surveyor-map.yaml` — item sprite brief (3 parchment-map variations)
- `src/shared/items.ts` — `gear('surveyor-map', …)` added to `ITEM_CATALOG` (index 127)
- `plans/item-icons/equipment-gear.art.yaml` — art-plan entry added
- `public/assets/generated/surveyor-map-placeholder.png` — 16×16 procedural placeholder
- `public/assets/generated/manifest.json` — `surveyor-map-placeholder` entry added
- `tests/unit/items.test.ts` — snapshot count updated (126 → 127)

## What was done

### Art brief

Authored `briefs/items/surveyor-map.yaml` describing a battered folded surveyor's map
with 3 variations (parchment/leather/cloth-bound). The brief name matches the stable
item ID (`surveyor-map`) so `resolveItemSprite('surveyor-map')` auto-resolves once the
real art is approved and checked in.

### Item wiring

Added `gear('surveyor-map', 'Surveyor Map', '…', U)` to `ITEM_CATALOG` following the
`oil-lantern` pattern (PR #1419). No `EquipmentItemDef` added — full slot assignment
(`accessory` slot) follows in the floor2 equipment contracts epic. The `gear()` factory
tags the item `Gear` and marks it non-stacking, which is correct for equippable accessories.

### Placeholder generation

`npm run sprites:gen-placeholders` (offline, no Azure required) wrote:

- `public/assets/generated/surveyor-map-placeholder.png` (16×16 procedural)
- Manifest entry `surveyor-map-placeholder` with `briefId: 'surveyor-map'`

### Verification

`npm run verify:fast` — all 1260 tests pass.

## Cloud generation status

The `asset-request.yml` workflow was triggered for issue #1389 on 2026-07-18T01:28 UTC
(run #29625257880) and **cancelled** before the drain step completed. The stale-claim TTL
(45 min) will expire and the ingest step in the next `issues`-triggered run will
automatically re-enqueue the item. When the drain completes:

1. A completion comment will appear on issue #1389
2. `npm run sprites:checkin` should be run locally (non-CI) to push the art branch
   off `nalfeo-floor-2-equipment-placeholders` and file an `asset-checkin` issue
3. The `asset-pr` skill consolidates all `asset-checkin` issues into one art PR
   targeting `nalfeo-floor-2-equipment-placeholders`

## PR

PR #1514 (`copilot/asset-request-surveyor-map`) — targets `main`.

The art wiring (brief + item + placeholder + art plan) is complete and mergeable
independently of the cloud art generation. Real art will resolve once the checkin
PR merges, with no further code changes needed.

## What remains

- [ ] Wait for cloud pipeline completion comment on issue #1389
- [ ] Run `sprites:checkin` locally (off `nalfeo-floor-2-equipment-placeholders`)
      once completion comment appears
- [ ] `asset-pr` skill to batch the art into the floor2 placeholders PR
- [ ] Full `EquipmentItemDef` with `accessory` slot assignment (floor2 contracts epic)
- [ ] Headless runtime verification once floor2 equipment contracts land in main

## Notes

- The floor2 placeholder system already has `equipment/accessory/surveyor-map` in
  `nalfeo-floor-2-equipment-placeholders`. The real art key will be `surveyor-map-var-N`
  (briefId: `surveyor-map`). Both coexist in the manifest.
- `resolveItemSprite('surveyor-map')` → `lookup('surveyor-map')` → `surveyor-map-var-N`
  once the art is approved. No additional code change needed after the checkin.
