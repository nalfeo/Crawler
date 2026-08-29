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
- Kept generated stat bonuses visible as tooltip stat rows instead of flavor text.
- After merging the ten-slot equipment tooltip redesign from `main`, generated stat rows are rendered by that redesign's shared `statLines` path, so this change is now limited to the flavor-text source.
- Moved flavor fallback coverage from a test-only helper export into the real `createInventoryUI` render-path integration test, which also asserts generated stat text stays within the tooltip content bounds.

## Validation

- Could not fetch the issue's signed run bundle from this sandbox because DNS resolution for the blob host failed.
- Before: `InventoryUI` built generated equipment `description` from slot labels, stat bonuses, and weight.
- After: `InventoryUI` builds generated equipment `description` from authored item flavor or a neutral fallback; mechanical stat bonuses render as tooltip stat rows via the shared redesign path.
- Real artifact observation: `npm run test:e2e -- tests/e2e/inventory-flow.test.ts` drove the browser InventoryUI and passed tooltip hover/pin/equipment states after the change.
- `npm run test:integration -- --run tests/integration/inventory-ui-weapon-dps-tooltip.integration.test.ts` ✅
- `npm run check:test-only-exports` ✅
- `npm run test:e2e -- tests/e2e/inventory-flow.test.ts` ✅
- `npm run typecheck` ✅
- `npm run format:check` ✅
- `npm run lint` ✅
- `npm run verify:fast` ✅

## Notes

- No `files/guard-telemetry.jsonl` artifact existed during this session, so no telemetry summary was generated.
