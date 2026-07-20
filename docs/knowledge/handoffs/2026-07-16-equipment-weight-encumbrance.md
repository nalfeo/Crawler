# Handoff: Author complete equipment weight values for encumbrance

**Date**: 2026-07-16  
**Issue**: #1204 — Author complete equipment weight values for encumbrance  
**Apple estimate**: 4🍎 (actual: 4🍎)

## Systems touched

inventory, hud-ux

## Summary

Implemented the full encumbrance-weight system from scratch:

- Added `readonly weightLb: number` (required, not optional) to `EquipmentItemDef`
- Created `src/shared/encumbrance.ts`: pure shared module with `EncumbranceBand`, STR-adjusted thresholds, move-penalty table, `computeEquippedWeightLb`, and display helpers
- Authored non-placeholder `weightLb` values for all 26 equipment defs (weapons, armor, accessories)
- Updated `EquipmentUI.ts` to show a compact LOAD row (gear lb / max lb / band label)
- Updated `equipment-lab` HUD to show gear load + band
- Added `weightLb` validation to `validateItemDef` (rejects NaN/negative)
- Added defensive clamp in `computeEquippedWeightLb` against invalid weights
- Fixed `toFixed(1)` precision bug for 0.25 lb items; added `formatLb` helper
- Fixed LOAD display denominator to use 3×cap (overloaded threshold) so numerator is always ≤ denominator in normal play

Observed in `npm run lab` (`?lab=equipment`) — LOAD row now shows e.g. `3/45lb` for sword-only (unburdened) and `21/45lb` for breastplate + sword (encumbered).

## Files Changed

| File                                    | Change                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `src/shared/equipment-types.ts`         | Added `readonly weightLb: number` to `EquipmentItemDef`                    |
| `src/shared/encumbrance.ts`             | **NEW** — full encumbrance module                                          |
| `src/shared/equipmentDefs.ts`           | Authored `weightLb` for all 26 defs                                        |
| `src/engine/EquipmentUI.ts`             | Added LOAD row + `formatLb` helper + `ENCUMBRANCE_HEAVY_FACTOR` import     |
| `src/labs/equipment-lab/index.ts`       | Added gear load + band to HUD                                              |
| `src/core/systems/equipmentSystem.ts`   | Added `weightLb` validation in `validateItemDef`                           |
| `tests/unit/shared/encumbrance.test.ts` | **NEW** — 37 unit tests (pure math + defensive guard + catalog validation) |
| Various test fixtures                   | Added `weightLb: 0` to inline `EquipmentItemDef` objects                   |

## Key Decisions Made

1. **`weightLb` required (not optional)**: Forces intentional authoring on all defs. Optional would let new defs silently default to `undefined`, undermining the acceptance criteria.

2. **Effective STR for carry cap in UI**: `EquipmentUI` queries `effective['strength']` which includes equipment bonuses (e.g. steel-pauldrons give +1 STR). This is correct gameplay behavior — a STR-boosting breastplate raises the carry cap. The pure-function unit tests take explicit `str` params; the test header documents the distinction.

3. **Encumbrance is display-only (movement penalty deferred)**: Move penalties are defined as data in `encumbrance.ts` but NOT wired into `moveSpeed` in the ECS pipeline. The UI shows the band; gameplay effect is a deliberate follow-up. The module comment and ADR document this.

4. **LOAD denominator = 3×cap (overloaded threshold)**: Using the unburdened cap as denominator made the display show numerator > denominator when encumbered (37/15 lb). The overloaded threshold (3×cap) gives a sensible fraction that stays ≤ 1 until truly maxed.

5. **`formatLb` helper**: `toFixed(1)` rounds 0.25 to "0.3" in JavaScript. The helper uses `parseFloat(n.toFixed(2)).toString()` which strips trailing zeros correctly.

## What's Next / Blockers

- **Wire movement penalty**: `ENCUMBRANCE_MOVE_PENALTIES` values defined but not applied to `moveSpeed` in `playerInputSystem.ts` or the effective-stats pipeline. This is the natural next step.
- **Encumbrance lab**: Consider creating a dedicated `encumbrance-lab` that lets designers tune thresholds and preview bands interactively (currently demoed via `equipment-lab`).
- **Dedup refactor (advisory)**: `computeEquippedWeightLb` and `uniqueEquippedDefs` in `effective-stats.ts` both traverse equipped instances with the same dedup pattern. Extracting a shared `uniqueEquippedInstances()` helper would reduce drift risk.

## Review Summary

- **Adversarial plan review** (gpt-5.4): 5 concerns → 4 resolved, 1 suggestion deferred
- **Multi-model code review** (claude-sonnet-4.6 + gpt-5.3-codex + gemini-3.1-pro-preview): 3 bugs found → all fixed
- **Security review** (gpt-5.4): clean
- Ledger: `docs/knowledge/review-ledgers/2026-07-16-equipment-weight-encumbrance.review-ledger.json`

## Verification Run

`npm run verify:fast` — 329+87 test files, 4003+1218 tests, all pass (0 failures).

## Retrospective

### Lessons Learned

- Making `weightLb` required caught all 26 definitions at compile time, and
  mirroring the existing equipped-instance dedup invariant kept multi-slot
  equipment from being counted more than once.
- Multi-model review caught two non-obvious presentation defects: JavaScript's
  `toFixed(1)` rounding for quarter-pound values and the misleading LOAD
  denominator when the player is already encumbered.

### Mistakes Made

- The initial test header described representative loadouts at Strength 1
  without accounting for steel pauldrons granting +1 Strength, so its prose did
  not match the real in-game band. The comment was corrected during review.

### Opportunities for Future Improvement

- Extract the shared unique-equipped-instance traversal used by encumbrance and
  effective stats, then wire the already-authored movement penalties through the
  canonical movement calculation with dedicated lab and runtime evidence.
