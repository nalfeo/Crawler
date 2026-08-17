# ADR 0086: Scenario-definition pipeline slots

## Status

Accepted

## Date

2026-08-16

## Estimated Complexity

🍎 x 4 — changes the canonical ordering configuration shared by visual and headless runtimes.

## Context

`createFloorMainSceneOptions` assembled one unconditional pre-system array for every floor. Floor 1 therefore ran three Floor 2 systems, while Floor 2 ran two Floor 1 systems. State guards prevented most foreign behavior, but `familyFeudSystem` still performed queries and rebuilt its spatial grid on Floor 1. The bootstrap array is also the ordering authority shared by the visual scene and headless runner, so separate per-floor arrays would risk runtime drift.

## Decision

- **DEC-001**: Add three optional executable slots to `ScenarioDefinition`:
  `beforeWeaponSystems`, `beforeEnemyAISystems`, and `afterSpawnerSystems`.
- **DEC-002**: Register Floor 1's player-stat and enemy-director systems only in
  Floor 1's definition, and Floor 2's victory, emergent-event, and family-feud
  systems only in Floor 2's definition.
- **DEC-003**: Keep one bootstrap assembler responsible for all shared systems
  and insert scenario contributions only at the named ordering seams.
- **DEC-004**: Treat scenario definitions as trusted runtime wiring sites in the
  orphaned-system guard. The guard continues to inspect function references
  rather than allowlisting the moved systems.
- **DEC-005**: Limit this decision to pre-system pipeline ownership. Existing
  floor-specific UI, reward, and transition callbacks remain out of scope.

## Consequences

### Positive

- **POS-001**: Each canonical floor pipeline contains zero foreign-floor
  pre-systems.
- **POS-002**: Bootstrap retains one shared ordering contract for visual and
  headless execution.
- **POS-003**: Adding a floor-local system at an existing seam requires only a
  scenario registration.
- **POS-004**: Floor 1 no longer pays the per-frame family-feud query and grid
  rebuild cost.

### Negative

- **NEG-001**: `ScenarioDefinition` now owns executable per-frame configuration
  in addition to initialization and interaction callbacks.
- **NEG-002**: New ordering seams require an explicit interface and bootstrap
  change rather than an arbitrary numeric priority.

### Risks

- **RSK-001**: A system registered in the wrong slot can change deterministic
  ordering. Table-driven wiring tests pin each slot between its shared anchors.
- **RSK-002**: Indirect wiring can evade a source-based guard unless the
  scenario registry remains in the guard's trusted wiring-site list.

## Alternatives Considered

### Complete per-floor pre-system arrays

- **ALT-001**: **Description**: Store every shared and local pre-system in each
  scenario definition.
- **ALT-002**: **Rejection Reason**: This duplicates the shared ordering
  contract and lets visual/headless behavior drift when common systems change.

### Generic ordered contributor descriptors

- **ALT-003**: **Description**: Register `{ system, slot, priority }`
  descriptors and sort them while assembling the pipeline.
- **ALT-004**: **Rejection Reason**: Numeric priorities add unnecessary
  ordering ambiguity for three stable, named seams.

### Bootstrap-owned floor registry

- **ALT-005**: **Description**: Keep a second map from floor identifiers to
  floor-local systems in the bootstrap layer.
- **ALT-006**: **Rejection Reason**: A parallel registry duplicates
  `ScenarioDefinition` ownership and makes adding a floor require coordinated
  edits in two places.
