# Handoff: storm-sling weapon icon — 2026-07-18

**Apple estimate:** 1🍎 (pure art-only; no code, no ledger required)  
**Branch:** `copilot/create-storm-sling-icon`  
**PR:** [#1399](https://github.com/nalfeo/Crawler/pull/1399)  
**Issue:** [#1320](https://github.com/nalfeo/Crawler/issues/1320)

## Work completed this session

| Step                       | Status     | Notes                                                                        |
| -------------------------- | ---------- | ---------------------------------------------------------------------------- |
| Brief authored             | ✅ done    | `briefs/weapons/storm-sling.yaml`                                            |
| Azure pipeline run         | ❌ blocked | `AZURE_OPENAI_ENDPOINT` missing in CI                                        |
| Placeholder PNG registered | ✅ done    | `public/assets/generated/storm-sling-placeholder.png` (16×16)                |
| Manifest entry added       | ✅ done    | key `storm-sling-placeholder`, `briefId: storm-sling`, `type: weapon`        |
| Sprite catalog synced      | ✅ done    | incidental `faerie-boss-var-0` added (was in manifest, missing from catalog) |
| `verify:fast`              | ✅ green   | 87 test files, 1260 tests pass                                               |

## Azure blocker

The CI environment reports `"Cloud/CI environment detected - skipping local .env.local setup"` when `npm run setup:azure:env` is run. The sprite generation pipeline exits with `Missing required env var 'AZURE_OPENAI_ENDPOINT'`.

**To resume art generation** once Azure credentials are available:

```bash
npm run setup:azure:env          # bootstrap .env.local (fast, ~18s)
npm run sprites:run -- --brief briefs/weapons/storm-sling.yaml
# Review generated sheet, pick best variant N
npm run sprites:approve -- generated/runs/storm-sling/<runId> --variant N
npm run sprites:checkin
# Then run the asset-pr skill to batch into art PR
```

## Brief summary

`briefs/weapons/storm-sling.yaml`:

- **Type:** weapon (vertical orientation, inherits all weapon.json defaults)
- **Description:** Compact recurve bow, vertical stance (grip at bottom, limbs curve outward), dark charcoal-brown bone/wood body with storm-rune engravings, pale-blue electric bowstring (glowing arc, not fiber)
- **Color scheme:** `#3a2e24` body, `#b09070` highlight ridge, `#9adaf0` electric string, `#4fa8d4` inner glow
- **Variations:** 3 seed variations + `minVariations: 8` (Azure text provider fills remainder)
- **Orientation:** vertical ±5° (default, no override needed)
- **Judge:** inherits `enabled: true` from `weapon.json`

## Systems touched

- `briefs/weapons/storm-sling.yaml` (new — art authoring contract)
- `public/assets/generated/storm-sling-placeholder.png` (new — 16×16 procedural placeholder)
- `public/assets/generated/manifest.json` (updated — `storm-sling-placeholder` entry added)
- `src/shared/data/sprite-catalog.json` (synced — catalog now reflects manifest)

## Wiring note

`storm-sling` is **not yet in `ITEM_CATALOG`** (`src/shared/items.ts`) or `equipmentDefs.ts`. The runtime key `equipment/weapon/storm-sling` identifies the asset in the Floor 2 equipment production wave tracking — the actual engine sprite lookup uses `briefId: "storm-sling"`. A follow-up wiring PR will need to:

1. Add `storm-sling` to `ITEM_CATALOG` as a `gear` or `weapon` item
2. Add an `EquipmentDef` entry with `weaponId: "storm-sling"`
3. Map `storm-sling` in loot tables / Floor 2 encounter defs
4. Run `npm run sprites:generate-wiring` after real art is approved

## Before / after

- **Before:** No `storm-sling` entry anywhere in the codebase. Manifest had 298 entries.
- **After:** Brief authored and ready for Azure generation. Manifest has 299 entries (`storm-sling-placeholder`). Placeholder PNG renders a recognisable bow silhouette in the inventory until real art ships.
