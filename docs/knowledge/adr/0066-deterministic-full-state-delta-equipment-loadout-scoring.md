# ADR 0066: Deterministic full-state-delta equipment loadout scoring

## Status

Accepted

## Date

2026-07-19

## Estimated Complexity

🍎🍎🍎🍎 — touches `src/shared/`, `src/core/`, `src/game/`, labs, and three test suites while fixing generated-equipment scoring semantics.

## Context

The Floor 2 generated-equipment epic already decided that deterministic AI may
score frozen instances by expected run value (ERV), but it did not lock how the
scorer should reason about displacement cost, equipment-granted abilities, or
same-template generated weapon identity.

The initial H1 plan used an item-centric additive score with explicit
displacement penalties. Adversarial plan review found that approach could
double-count value, miss interactions between multiple slots, and drift from the
same effective-stat pipeline the runtime uses for generated equipment,
encumbrance, and source-owned ability grants.

The shipped branch also had to preserve deterministic ordering for AI callers:
the same loadout snapshot and the same candidate instances must always produce
the same ordering, even when two instances share the same base weapon template
or when equipment abilities overlap with non-equipment grants.

## Decision

- **DEC-001**: Equipment evaluation scores a complete hypothetical loadout, not a
  standalone item. Candidate ERV is `scoreLoadout(hypothetical) -
scoreLoadout(current)`.
- **DEC-002**: `scoreLoadout(...)` uses one deterministic composite score with
  three components: DPS, defense, and ability access. DPS must consume the same
  effective-stat and frozen-weapon snapshot data the generated-equipment runtime
  already owns.
- **DEC-003**: Ability-access scoring is source-aware. Equipment-granted actives
  and passives count only while their non-equipment and equipment ownership
  state says they are really available; the scorer may not treat a bare ability
  ID set as authoritative.
- **DEC-004**: Generated weapon tie-breaking and identity use the frozen
  instance/snapshot identity rather than only the base weapon definition ID, so
  two rolled copies of the same template remain distinct to the evaluator and
  active-weapon plumbing.
- **DEC-005**: Candidate ordering is deterministic and stable: primary ordering
  is ERV, with a stable instance-based tie-breaker when two candidates score the
  same.

## Consequences

### Positive

- **POS-001**: Displacement cost is captured automatically by comparing complete
  current vs hypothetical loadouts, so the evaluator does not need a fragile
  separate penalty model.
- **POS-002**: The scorer stays aligned with generated-equipment, encumbrance,
  and source-owned ability runtime contracts instead of inventing a parallel AI
  interpretation.
- **POS-003**: Same-template generated items remain distinguishable, which avoids
  stale active-weapon identity and unstable tie ordering.

### Negative

- **NEG-001**: The evaluator must construct more complete hypothetical state than
  an item-only heuristic, so the implementation touches more surfaces.
- **NEG-002**: Tests need to cover source ownership, generated snapshot identity,
  and deterministic tie behavior together, not just simple stat deltas.

### Risks

- **RSK-001**: If future runtime stat semantics change without updating
  `scoreLoadout(...)`, AI purchase/equip decisions can drift from actual combat
  value.
- **RSK-002**: If a future caller bypasses frozen instance identity and falls
  back to base-weapon-ID comparisons, same-template generated instances could
  collapse again.

## Alternatives Considered

### Item-centric additive ERV

- **ALT-001**: **Description**: Score each candidate item in isolation and add an
  explicit displacement-cost term for whatever would be unequipped.
- **ALT-002**: **Rejection Reason**: The plan review found it double-counted
  value and failed to model multi-slot interactions and source-owned abilities
  cleanly.

### Encounter-abstract combat simulation

- **ALT-003**: **Description**: Run a richer per-candidate abstract combat model
  to estimate value directly from encounter scripts.
- **ALT-004**: **Rejection Reason**: Too expensive and complex for H1; the branch
  already had the deterministic effective-stat pipeline needed for a cheaper
  full-state delta.

### Base-weapon-ID-only identity

- **ALT-005**: **Description**: Treat generated weapons with the same base
  `WeaponDef` as equivalent for scoring and switching.
- **ALT-006**: **Rejection Reason**: Two generated copies can legitimately differ
  in frozen combat fields, so base-ID-only identity collapses distinct items and
  breaks deterministic switching/tie semantics.
