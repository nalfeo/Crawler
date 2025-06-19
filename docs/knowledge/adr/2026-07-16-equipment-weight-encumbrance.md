# ADR: Equipment weight field and encumbrance display system

## Status

Accepted

## Context

Issue #1204 requires every `EquipmentItemDef` to have an intentionally authored `weightLb` value
so real loadouts exercise a shipped encumbrance system. The primary stat-system overhaul described
in the issue had not yet merged, so the encumbrance architecture was built here from scratch.

The existing equipment system had no weight concept. `EquipmentItemDef` held slots, stat bonuses,
rarity, and requirements — but nothing about mass. The `EquipmentUI` rendered a stats column with
no load readout.

## Decision

1. **`weightLb` is a required field on `EquipmentItemDef`** (not optional).
   - All 26 defs get non-placeholder values authored in this PR.
   - Compile-time enforcement prevents future defs from silently omitting it.
   - `validateItemDef` in `equipmentSystem.ts` rejects non-finite or negative `weightLb` at equip time.

2. **All encumbrance logic lives in `src/shared/encumbrance.ts`** (pure, no ECS imports).
   - Importable from both `src/core/` and `src/engine/` layers without crossing the layer rule.
   - Exports: `EncumbranceBand`, threshold constants, penalty table, `computeEquippedWeightLb`,
     `getCarryThresholdLb`, `getEncumbranceBand`, `getEncumbranceMovePenalty`, display helpers.

3. **Carry capacity scales with effective Strength** (including equipment bonuses).
   - `getCarryThresholdLb(str)` = `BASE_LB(10) + PER_STR_LB(5) × max(1, floor(str))`
   - `EquipmentUI` queries `effective['strength']` after aggregating all equipped stats.
   - Pure-function unit tests pass explicit STR params; the test file header documents that
     the real game uses effective STR so some "representative" scenarios differ.

4. **Four bands at multiples of the unburdened threshold**:
   - unburdened ≤ cap; encumbered ≤ 2×cap; heavy ≤ 3×cap; overloaded > 3×cap
   - LOAD row denominator = 3×cap (overloaded threshold), not cap, so the fraction is always ≤ 1
     in normal play and avoids the visually incoherent `37/15lb HEAVY` display.

5. **Movement penalties defined as data; application deferred**.
   - `ENCUMBRANCE_MOVE_PENALTIES` table is exported from `encumbrance.ts`.
   - Wiring into `moveSpeed` in the ECS pipeline is a follow-up task.
   - The UI shows the band label regardless; players can see load before mechanics land.

6. **`computeEquippedWeightLb` deduplicates multi-slot items** via instance-id,
   matching the invariant in `uniqueEquippedDefs` (`src/core/effective-stats.ts`).
   A defensive guard clamps invalid `weightLb` values (NaN/Infinity/negative) to 0 so
   a bad def cannot silently corrupt the total even if `validateItemDef` is bypassed.

## Alternatives Considered

**A. `weightLb?: number` optional with default 0**
Rejected: optional would silently default new defs to 0 (a placeholder), defeating the acceptance
criterion that requires "every EquipmentItemDef has an intentionally authored, non-placeholder value."

**B. Separate WeightTable keyed by item id**
Rejected: adds indirection for a simple per-item scalar. The def already holds similar per-item
scalars (statBonuses, rarity, requirements). Encumbrance weight is intrinsic to the item, not a
separate balance layer.

**C. Derive encumbrance inside the effective-stats pipeline**
Rejected for this PR: the only current consumer is the UI display, not a stat computation. Wiring
into the ECS pipeline is deferred to the movement-penalty follow-up. Moving it into effective-stats
now would add complexity before the mechanic is wired.

## Consequences

**Positive**

- Every future `EquipmentItemDef` must have an intentional `weightLb` — the type system enforces it.
- `encumbrance.ts` is fully pure and testable; 37 unit tests cover all bands + catalog validation.
- The LOAD readout gives players immediate legible feedback on their loadout weight.

**Negative / Risks**

- Movement penalties are visible in the UI before they affect gameplay — players can see
  `HEAVY` while their speed is unchanged. Acceptable until the follow-up wires the penalty.
- `computeEquippedWeightLb` and `uniqueEquippedDefs` share the same dedup pattern but are
  separate implementations. A future change to multi-slot semantics must update both.

## References

- Issue #1204: Author complete equipment weight values for encumbrance
- `src/shared/encumbrance.ts`
- `src/core/systems/equipmentSystem.ts` (validateItemDef)
- `tests/unit/shared/encumbrance.test.ts`
- Handoff: `docs/knowledge/handoffs/2026-07-16-equipment-weight-encumbrance.md`
