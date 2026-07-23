# Wave B display-name override authority — post-merge correction

**Date:** 2026-07-23
**Branch:** `nalfeo-wave-b-display-name-authority-fix`
**Apple estimate:** 2🍎
**Actual complexity:** 2🍎

## Systems touched

inventory, weapons

## What was done

PR #1809 squash `b72d9d8df2f639aba3b4086ce8ccd6fcd9e15bf4` merged Floor 2
equipment Wave B without an explicitly locked review correction: the
Quartermaster display-name override table (`head.iron-visor` → "Iron
Faceplate", `feet.iron-greaves` → "Iron Legguards") was left as a private
const in `src/shared/data/floor2-equipment-wave-b.ts` instead of living in the
canonical art manifest module, `src/shared/data/floor2-equipment-art.ts`.

- Exported the frozen override table as
  `FLOOR2_WAVE_B_DISPLAY_NAME_OVERRIDES` from `floor2-equipment-art.ts`,
  documented as the single authority for Wave B Quartermaster name
  disambiguation.
- `floor2-equipment-wave-b.ts` now imports and consumes the table via its
  existing `waveBDisplayName()` helper instead of redefining it. No
  behavioral change to the resolved names.
- Left `FLOOR2_EQUIPMENT_ART_DEFINITIONS` (canonical manifest) and its
  `briefInput.name`/`briefInput.description` fields byte-semantically
  unchanged — the override table only affects the Wave B _runtime_
  `EquipmentItemDef.name`, never the art manifest or brief input.

## Content boundary

No sprites, briefs, manifests, queues, asset PRs, or Azure resources were
touched. This is a pure data/wiring relocation inside `src/shared/data/`.

## Acceptance evidence

- New regression test: `FLOOR2_WAVE_B_DISPLAY_NAME_OVERRIDES` is exported
  from `floor2-equipment-art.ts`, frozen, and NOT re-exported/redefined by
  `floor2-equipment-wave-b.ts` (asserts the module's export list).
- New regression test: canonical manifest `briefInput.name`/`description` for
  the two overridden stable IDs remain the manifest-derived name (never equal
  to the override), while the Wave B runtime equipment def resolves the
  override — proving runtime-only application.
- Existing tests continue to assert exact uniqueness of all Quartermaster
  generated-base display names, the locked 25-weapon/20-non-weapon roster,
  zero Wave A/B overlap, and legacy identity compatibility
  (`iron-visor`/`iron-greaves` legacy Floor 1 items keep their own names).
- No assets, runtime keys, or roster IDs were generated, judged, checked in,
  or mutated.

## Validation

- Focused: `npx vitest run tests/unit/floor2-equipment-wave-b.test.ts
tests/ecs/equipment.test.ts` — 2 files, 63 tests passed.
- `npm run verify:fast` — passed (196 test files, 2371 tests, plus
  physics-defs/size/weight coverage checks).
- `npm run review:ledger -- validate
docs/knowledge/review-ledgers/2026-07-23-wave-b-display-name-authority-fix.review-ledger.json`
  — passed (2-apple ledger, no required stages).

## Review

2🍎 per policy: no plan-review/code-review/multi-model stages required. Ledger
records the tier only.

## Coordination

Requested by the "Floor 2 equipment" session
(`d014bdcd-ea9f-4393-a2f2-a667927d2e51`) after independently verifying the
Wave B squash did not carry the locked file-location correction. PR/merge SHA
reported back to that session on completion.
