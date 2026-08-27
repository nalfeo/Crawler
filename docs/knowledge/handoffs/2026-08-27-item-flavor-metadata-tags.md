# Handoff: Item flavor metadata tag leak

## Date

2026-08-27

## Persona

Content Designer / UX Designer

## Systems touched

inventory

## Apples

2 apples estimated, 2 apples actual.

## What was done

- Stopped generated equipment inventory tooltips from using slot/stat/weight metadata as the `ItemDef.description` flavor line.
- Added `generatedEquipmentTooltipDescription()` so generated equipment reuses authored static item flavor when the base maps to `ITEM_CATALOG`, otherwise it uses a neutral generated-equipment fallback.
- Kept generated slot/stat/weight metadata visible by moving it into the tooltip stat-line area instead of the flavor-text area.
- Added unit coverage for known-base authored flavor and generated-only fallback behavior.

## Validation

- Could not fetch the issue's signed run bundle from this sandbox because DNS resolution for the blob host failed.
- Before: `InventoryUI` built generated equipment `description` from slot labels, stat bonuses, and weight.
- After: `InventoryUI` builds generated equipment `description` from authored item flavor or a neutral fallback; mechanical metadata remains in `statLine`.
- `npm test -- tests/unit/inventory-ui-generated-tooltip.test.ts` ✅
- `npm test -- tests/unit/inventory-ui-generated-tooltip.test.ts tests/unit/items.test.ts tests/unit/inventory.test.ts` ✅
- `npm run typecheck` ✅
- `npm run format:check` ✅
- `npm run lint` ✅
- `bash scripts/agent/verify-fast.sh` ✅

## Notes

- No `files/guard-telemetry.jsonl` artifact existed during this session, so no telemetry summary was generated.
