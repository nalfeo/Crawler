# Handoff: Item Icon Briefs for Floor 1

**Date:** 2026-06-23
**Persona:** Graphics Designer

## What Was Done

Created sprite briefs for all items currently available in the inventory and
equipment panes, and fixed two items that were in loot tables but missing from
ITEM_CATALOG.

## Items Covered

| Item ID                   | Brief file                                  | Notes                                    |
| ------------------------- | ------------------------------------------- | ---------------------------------------- |
| `iron-ore`                | `briefs/items/iron-ore.yaml`                | Drops from ELITE/BOSS loot               |
| `rusted-scrap`            | `briefs/items/rusted-scrap.yaml`            | Drops from FLOOR_1                       |
| `old-sock`                | `briefs/items/old-sock.yaml`                | Drops from FLOOR_1                       |
| `bone-shard`              | `briefs/items/bone-shard.yaml`              | Also added to ITEM_CATALOG (was missing) |
| `pebble`                  | `briefs/items/pebble.yaml`                  | Also added to ITEM_CATALOG (was missing) |
| `glistening-rat-tail`     | `briefs/items/glistening-rat-tail.yaml`     | Shopkeeper quest fetch item              |
| `merchants-stained-charm` | `briefs/items/merchants-stained-charm.yaml` | Equippable neck slot                     |
| `floor-key-bronze`        | `briefs/items/floor-key-bronze.yaml`        | Door unlock key                          |

## Bug Fixes

`bone-shard` and `pebble` were referenced in `src/shared/loot-tables.ts` but
absent from `ITEM_CATALOG`. `getItemIndex()` returned -1 for both, so the drop
system's `itemIndex >= 0` guard silently discarded them — they never actually
dropped. Both are now added to the catalog:

- `bone-shard` → Materials category
- `pebble` → Misc category

## What's Next

The briefs exist but no sprites have been generated yet. Someone with Azure
OpenAI API access needs to run the generation pipeline:

```bash
# Generate candidates for each item
npm run sprites:batch -- --briefs-dir briefs/items

# Or one at a time:
npm run sprites:run -- --brief briefs/items/iron-ore.yaml
# Review candidates, then:
npm run sprites:approve -- generated/runs/iron-ore/<run-id> --variant <n>
```

Use the art plan to track status:

```bash
npm run sprites:asset-plan -- --plan plans/item-icons/floor1-item-icons.art.yaml
```

Once sprites are approved, `InventoryUI` will automatically display them because
it already does `getGeneratedRegistry().lookup(def.id)` — the brief name matches
the item id slug exactly.

## Apples

**Estimate:** 🍎🍎🍎 (Medium) — 8 brief YAML files, 2 catalog additions,
1 art plan, test updates.

**Actual:** 🍎🍎🍎 — Accurate estimate. Multiple files, cross-cutting fix
(catalog bug), no ECS systems.

**Verdict:** On target.

## Systems touched

inventory
