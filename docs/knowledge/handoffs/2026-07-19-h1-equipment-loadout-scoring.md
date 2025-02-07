# H1 Equipment Loadout Scoring — Handoff

**Date:** 2026-07-19  
**Session:** h1-equipment-loadout-scoring  
**Branch:** `copilot/nalfeo-d1-deterministic-equipment-generator-another-one`  
**Target PR base:** `nalfeo-d1-deterministic-equipment-generator`  
**Apple estimate:** 🍎🍎🍎🍎  
**Status:** Implementation complete, review in progress

## Systems touched

generated-equipment, ai, equipment-evaluator, stats, encumbrance

## What was done

Implemented H1 — the pure deterministic build-affinity and expected-run-value (ERV) evaluator for AI equipment decisions (issue #1568).

### Architecture decision (major fork from initial plan)

The adversarial plan review rejected the item-centric additive ERV + displacement-costs approach and required the **full-state-delta** architecture:

```
ERV(candidate) = scoreLoadout(hypothetical) - scoreLoadout(current)
```

`scoreLoadout` evaluates a complete loadout snapshot to a 3-component score:

1. **DPS** — `(baseDamage + dmgBonus) × (1 + dmgPercent) × typedPrimaryMultiplier × accuracy × critEV / effectiveCooldownSec × encumbranceMult × encounterFitMult`
2. **Defense** — `eHP × defenseWeight` (flat armor reduction)
3. **AbilityAccess** — `configuredActiveAbilityCount × abilitySlotWeight × remainingFractionDiscount`

The delta approach captures displacement/opportunity cost automatically — no separate cost term needed.

### Files created

- `src/game/ai/equipment-evaluator.ts` — H1 evaluator (pure, no world mutation, no Phaser imports)
- `src/labs/equipment-evaluator-lab/index.ts` — Interactive lab demonstrating ERV scoring
- `tests/game/equipment-evaluator.test.ts` — 17 fixed-fixture tests
- `tests/property/equipment-evaluator.property.test.ts` — 6 property tests
- `tests/integration/equipment-evaluator-runtime.test.ts` — 6 runtime integration tests
- `docs/knowledge/review-ledgers/2026-07-19-h1-equipment-loadout-scoring.review-ledger.json` — Review ledger

### Files modified

- `src/shared/generated-equipment-types.ts` — Added `ActiveWeaponCombatOverridesV1`, `ActiveWeaponSnapshotCreateInputV1`, `FrozenEquipmentFieldsCreateInputV1`; updated `GeneratedEquipmentCreateInputV1.frozen` type
- `src/core/generated-equipment-registry.ts` — Added `createActiveWeaponSnapshotInput()`, `isActiveWeaponSnapshotCreateInput()`, `buildSnapshotFromCreateInput()`; updated `validateFrozenFields`
- `src/game/generated-equipment-generator.ts` — Fixed `'kind' in effect` guards for `LegacyResolvedEquipmentEffectV1` narrowing
- `tests/game/generated-equipment-generator.test.ts` — Fixed field name, narrowing guards
- `tests/property/generated-equipment-generator.property.test.ts` — Fixed narrowing guards
- `src/lab-main.ts` — Registered `equipment-evaluator` lab
- `scripts/agent/pr-lab-links.mjs` — Added lab gate for `src/game/ai/equipment-evaluator`

D1/C2 pre-existing type errors (abilities.ts, abilitySystem.ts, active-weapon.ts, etc.) were fixed by a separate sub-session; handoff at `docs/knowledge/handoffs/2026-07-19-d1-c2-typescript-merge-recovery.md`.

## Key invariants

- **Determinism**: same `LoadoutEvalContext` + same instances → identical ERV every time
- **No mutation**: all inputs are treated as immutable; all collection operations return new objects
- **Tie-breaking**: `sortKey = <ERV padded to 30 chars>:<instanceId>` — stable across reordered inputs
- **Finiteness**: cooldownMs is clamped to min 0.001s; encumbrance falls back to 1.0 for non-finite values

## Next session

- PR is non-draft, targeting `nalfeo-d1-deterministic-equipment-generator`
- Does NOT merge or arm auto-merge (per acceptance criteria)
- No merchant stock/purchase, achievement opening, or route planning work done
