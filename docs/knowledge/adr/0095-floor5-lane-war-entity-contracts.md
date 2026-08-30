# ADR 0095: Floor 5 lane-war entity contracts

## Status

Proposed

## Date

2026-08-30

## Estimated Complexity

🍎 x 4 — touches core ECS contracts, Floor 5 scenario logic, headless telemetry, lab display, and deterministic tests.

## Context

Floor 5 Slice 2 turns the Slice 1 siege foundation into a real lane-war loop:
opposing allied/enemy minion waves must spawn from immutable manifests, contest a
checkpoint front, target structures strategically, damage only legal opposing
targets, and immediately fail the run when the allied Command Post reaches zero
health. The implementation has to run through the real ScenarioDefinition path
used by both the windowed game and headless runner; lab-only validation is not
sufficient.

The existing Crawler combat stack already owns damage application and combat
events, and the existing map/pathfinding stack already owns passability. Floor 5
therefore needed a small, explicit contract for siege-only actors without
overloading generic enemy semantics or duplicating shared combat/navigation.

## Decision

Floor 5 lane-war actors use explicit floor-scoped ECS marker components:
`SiegeMinion` for autonomous wave combatants and `SiegeStructure` for lane
objectives. Both also carry the shared `Team` component using dedicated siege
team IDs. Structures are damageable `Health` entities, but they are not generic
`Enemy` entities, so enemy AI, drops, and unrelated hostile systems do not
interpret them as normal mobs.

The Floor 5 authority is split by tick phase. `siegeMinionSystem` runs from the
ScenarioDefinition `beforeEnemyAISystems` slot and owns immutable-manifest wave
release, bounded per-team spawn debt, minion spawning, target selection, and
shared pathfinding steering. `floor5ObjectiveTick` runs through the normal floor
objective hook after shared damage processing and owns minion contact damage via
`applyDamage`, legal/illegal combat-event audit, checkpoint front ownership,
structure health synchronization, and immediate Command Post defeat precedence.

The wave manifest is generated once from the isolated `waves` RNG stream and is
frozen. Runtime spawn debt queues retain the manifest index that created each
debt item, so minions can be traced back to stable manifest entries even when
debt is spawned later. Combat-event auditing tolerates the render layer draining
`world.combatEvents` by detecting cursor staleness before scanning.

## Consequences

### Positive

- **POS-001**: Siege teams and structures have a durable ECS contract that tests,
  labs, targeting, and future slices can query directly.
- **POS-002**: Reusing `applyDamage` and shared tile pathfinding keeps Floor 5 on
  existing deterministic combat/navigation infrastructure.
- **POS-003**: Splitting pre-step minion strategy from post-damage objective
  authority makes same-tick Command Post defeat deterministic and testable.
- **POS-004**: Immutable wave manifests plus per-team debt queues make wave
  release reproducible and prevent combat timing from consuming RNG.

### Negative

- **NEG-001**: Floor 5 now has additional marker stores and scenario state that
  must be preserved when future systems manipulate siege entities.
- **NEG-002**: The first lane-war slice still uses per-minion pathfinding; this is
  acceptable under the current live cap but future larger waves may need cached
  route fronts or authored waypoint progression.
- **NEG-003**: Structures intentionally avoid generic `Enemy` tagging, so future
  systems that expect enemies by query must explicitly opt in to siege markers.

### Risks

- **RSK-001**: Future slices could accidentally infer allegiance from entity type
  instead of `Team`; tests should continue to assert legal-only damage.
- **RSK-002**: Recycled EIDs can corrupt stored structure references if identity
  checks are skipped; health sync now validates `SiegeStructure` kind and team
  before trusting an entity ID.
- **RSK-003**: Render consumers may drain transient combat-event arrays; any
  future Floor 5 event cursor must use a staleness reset pattern.

## Alternatives Considered

### Reuse generic Enemy entities for structures and minions

- **ALT-001**: **Description**: Tag siege structures and minions as generic
  enemies/allies and let existing enemy AI, drops, and death-driven systems see
  them.
- **ALT-002**: **Rejection Reason**: Generic enemy semantics would leak drops,
  AI decisions, XP side effects, and floor-objective assumptions into siege
  objectives. Floor 5 needs legal damageability without pretending that every
  structure is a normal mob.

### Store siege contracts only in Floor 5 sidecar state

- **ALT-003**: **Description**: Keep minion/structure metadata in
  `world.floorExtendedState.floor5Siege` and identify entities by sidecar maps.
- **ALT-004**: **Rejection Reason**: Sidecar-only contracts are harder for ECS
  tests, labs, and future systems to query; they also make EID reuse bugs more
  likely unless every lookup revalidates identity manually.

### One all-in-one director system

- **ALT-005**: **Description**: Expand `siegeDirectorSystem` to release waves,
  steer minions, apply damage, own checkpoints, and resolve terminal states.
- **ALT-006**: **Rejection Reason**: A god-object director would duplicate
  existing combat/navigation responsibilities and make tick ordering ambiguous.
  Keeping minion strategy pre-step and objective authority post-damage preserves
  existing pipeline contracts.

### Add a new navigation implementation for siege lanes

- **ALT-007**: **Description**: Build a bespoke lane movement kernel instead of
  using the shared tile pathfinder.
- **ALT-008**: **Rejection Reason**: The issue requires reusing shared
  navigation, and the current live cap keeps pathfinding bounded for Slice 2.
  A future optimization can cache routes or convert to waypoint fronts without
  changing the ECS/team contracts.
