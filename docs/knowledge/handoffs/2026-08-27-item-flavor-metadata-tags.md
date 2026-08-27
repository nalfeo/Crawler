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
- Recovered PR review feedback by rendering generated-equipment metadata as separate wrapped tooltip stat rows, with tooltip height derived from measured wrapped text height.
- Moved flavor fallback coverage from a test-only helper export into the real `createInventoryUI` render-path integration test, which also asserts generated stat text stays within the tooltip content bounds.

## Validation

- Could not fetch the issue's signed run bundle from this sandbox because DNS resolution for the blob host failed.
- Before: `InventoryUI` built generated equipment `description` from slot labels, stat bonuses, and weight.
- Review-recovery before: `InventoryUI` joined DPS, slot, stat, and weight metadata into one unwrapped tooltip stat line.
- After: `InventoryUI` builds generated equipment `description` from authored item flavor or a neutral fallback; mechanical metadata renders as wrapped, separate stat rows with measured tooltip height.
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
