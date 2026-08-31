# Handoff: Generated tooltip slot/weight stat rows

## Date

2026-08-28

## Persona

UX Designer

## Systems touched

inventory

## Apples

2 apples estimated, 2 apples actual.

## What was done

Shepherd follow-up on PR #3873. The flavor-text fix in that PR replaced the
generated equipment `description` (which had been carrying
`slot · stats · weight`) with authored/neutral flavor copy, but nothing put the
evicted slot and weight details back anywhere. `showTooltip` built `statLines`
from DPS plus `statBonuses` only, and `renderItemTooltip` has no access to
`instance.frozen`, so "Main Hand" and "4 lb" vanished from the tooltip entirely
instead of moving into stat metadata as the PR description promised.

- Added `generatedEquipmentMetadataStatLine()` in `src/engine/InventoryUI.ts`,
  which formats `slots.map(getSlotLabel).join(' / ')` and `${weightLb} lb` into
  one stat row.
- `showTooltip` now emits that row for generated instances, ordered after the
  DPS lead line and before the bonus stat rows.
- Deliberately one combined row, not two: `renderItemTooltip` renders only
  `statLines.slice(0, 5)`, so spending two lines here could push a real stat
  bonus off a generated weapon that already leads with DPS. Placing it ahead of
  the bonus rows also guarantees it survives that cap.

## Validation

- Before: hovering a generated weapon rendered `DPS: …` plus bonus rows only —
  no slot, no weight anywhere in the tooltip.
- After: the same hover renders `Main Hand · 4 lb` between the DPS line and the
  bonus rows.
- Real artifact observation is the render-path integration test, which drives
  the actual `createInventoryUI` hover path and records every emitted text
  string (not a lab): it asserts the metadata row's index is greater than the
  DPS index and less than the first bonus-stat index, and that the row is also
  present on the neutral-fallback base.
- Tooltip height for the generated weapon grew 152 → 166 (one additional 14px
  stat line), which is the expected consequence of the new row and is asserted.
- `npx vitest run --project integration tests/integration/inventory-ui-weapon-dps-tooltip.integration.test.ts` ✅
- `npm run verify:fast` ✅

## Notes

- `lab-gate-check.sh` was not run locally (Windows Git Bash); CI enforces it.
- No `files/guard-telemetry.jsonl` artifact existed during this session, so no
  telemetry summary was generated.
