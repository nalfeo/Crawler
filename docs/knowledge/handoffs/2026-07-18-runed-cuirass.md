# Handoff: runed-cuirass Floor 2 Equipment — 2026-07-18

**Apple estimate:** 2 🍎 (art brief + wiring; no novel engine change)  
**PR:** nalfeo/Crawler#1464 (`copilot/add-runed-cuirass-icon`)  
**Issue:** nalfeo/Crawler#1373 (closes)  
**Wave:** `floor2-equipment-ui-torso`

---

## Summary

Added `runed-cuirass` as a Floor 2 rare chest-slot equipment piece. The item is now fully wired into the game's item catalog and equipment definitions. A procedural placeholder sprite is committed so the item renders functionally; the real Azure-generated art will replace it once the `asset-request` workflow re-runs.

---

## Systems touched

| System                | File                                                    | Change                                                                                       |
| --------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Item catalog          | `src/shared/items.ts`                                   | Added `gear('runed-cuirass', 'Runed Cuirass', ..., R)` after `iron-breastplate`              |
| Equipment definitions | `src/shared/equipmentDefs.ts`                           | Added chest-slot entry: armor:6, int:2, con:1, rarity:rare, weightLb:14                      |
| Sprite brief          | `briefs/items/runed-cuirass.yaml`                       | Azure generation brief; dark-metal breastplate + electric-blue rune glow; judge.enabled:true |
| Placeholder art       | `public/assets/generated/runed-cuirass-placeholder.png` | 16×16 procedural placeholder                                                                 |
| Sprite manifest       | `public/assets/generated/manifest.json`                 | Entry added by `sprites:gen-placeholders`                                                    |
| Sprite catalog        | `src/shared/data/sprite-catalog.json`                   | Synced by `sprites:sync-catalog`                                                             |
| Art plan              | `plans/item-icons/equipment-gear.art.yaml`              | New entry for runed-cuirass                                                                  |
| Test snapshots        | `tests/unit/items.test.ts`                              | Catalog size: 126 → 127                                                                      |
| Test snapshots        | `tests/ecs/equipment.test.ts`                           | GEAR_ITEM_IDS length: 15 → 16                                                                |

---

## Before / after

**Before:** `runed-cuirass` item did not exist; no chest-slot rare available in Floor 2.  
**After:** Item is in ITEM_CATALOG and GEAR_EQUIPMENT_DEFS; renders with placeholder sprite (equipment UI resolves via `resolveItemSprite(registry, 'runed-cuirass', seed)`); `verify:fast` passes (1260 tests).

---

## Remaining steps for full art completion

1. **Re-add `asset-request` label to issue #1373** — Azure credentials live in the CI workflow secrets; the label triggers `asset-request.yml` to generate the real sprite via Azure OpenAI.
2. Once generated + approved by the judge, the workflow opens an `asset-checkin` issue.
3. Run the `asset-pr` skill to batch it into an art-only PR (fast lane, review-ledger-exempt).
4. After the art PR merges, the placeholder is automatically superseded — `resolveItemSprite` will find `runed-cuirass-var-N` ahead of the placeholder.

---

## Art decision log

- **Brief ID:** `runed-cuirass` (bare slug per ADR 0051 — no floor/lineage suffix)
- **Runtime key clarification:** The issue's `equipment/torso/runed-cuirass` is metadata from `FLOOR2_EQUIPMENT_ART_DEFINITIONS`; actual code ID is the bare slug.
- **Stats rationale:** Slightly stronger than `iron-breastplate` (armor:4→6, adds int:2) to reflect Floor 2 rare tier.
- **Azure generation:** Not available in this runner; `asset-request.yml` workflow owns the credentials.
