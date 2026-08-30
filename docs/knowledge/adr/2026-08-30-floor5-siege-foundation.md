# ADR: Floor 5 siege foundation uses shared scenario plumbing

## Status

Accepted

## Date

2026-08-30

## Estimated Complexity

🍎 x 3 — establishes a new authored floor foundation across map generation,
scenario/runtime wiring, lab registration, and deterministic verification.

## Context

Issue #3911 asks for Floor 5 Slice 1: a manifest/registry/scenario foundation,
an authored Command Post-to-throne siege map, siege phase state, a
`siegeDirectorSystem` authority boundary, isolated RNG stream keys, a required
lab, and real `ScenarioDefinition` wiring. The
done condition is that the windowed game path and headless runner load the same
reachable authored Floor 5 map and emit the same empty deterministic phase
trace.

- **CTX-001**: Floor 5 depends on a named battlefield shape, not a generic
  random dungeon: Command Post, Siege Yard, task pockets, breach site,
  courtyard, throne room, and Winner's Balcony must remain stable across
  windowed and headless boot.
- **CTX-002**: The project already routes floor-specific runtime behavior
  through `ScenarioDefinition` so `createFloorMainSceneOptions`, the real game,
  and the headless runner share scenario setup instead of branching separately.
- **CTX-003**: Slice 1 must avoid implementing later gameplay slices: no live
  waves, Heroes, ram damage, breach collision transaction, throne capture, or
  balance tuning.
- **CTX-004**: Determinism requires Floor 5 scaffolding to avoid consuming the
  shared world RNG stream while still declaring isolated floor-specific stream
  keys for future slices.

## Decision

Add Floor 5 as a non-MVP, unreleased scenario that uses the existing shared
scenario plumbing as the single runtime authority.

- **DEC-001**: Add `floor5.manifest.json` plus manifest/registry schema support
  for the authored siege geometry, initial/terminal phase skeleton, and
  isolated RNG stream labels.
- **DEC-002**: Add `SiegeCastleGenerator` for `BiomeType.SIEGE_CASTLE`. The
  generator carves the authored Command Post-to-throne route deterministically
  and consumes no RNG in Slice 1.
- **DEC-003**: Add `Floor5SiegeState`/`Floor5SiegeRunStats` with current phase,
  command-post health, future subsystem latches, manifest-derived RNG stream
  keys, and an initially empty trace.
- **DEC-004**: Add `initializeFloor5Scenario` and `siegeDirectorSystem`.
  `siegeDirectorSystem` owns only phase/latch authority and abnormal terminal
  transition recording; it does not spawn, pathfind, steer, attack, or apply
  damage.
- **DEC-005**: Wire Floor 5 through `ScenarioDefinition` slots, including the
  `afterSpawnerSystems` director hook, run-stats collection, and scene-option
  creation path used by both the windowed game and headless runner.
- **DEC-006**: Do NOT register a Floor 5 `aiTaskConfig` in this slice. The BT
  goal-graph planner is reachable only through `world.floorScenario.objective`,
  which `initializeFloor5Scenario` leaves null because no siege gameplay ships
  here, so a route registered now would be unreachable at runtime. The route
  lands with the slice that makes `Floor5SiegeState` authoritative for its
  latches.
- **DEC-007**: Add a `floor5-siege-lab` for isolated inspection while keeping
  real-artifact proof in unit/headless tests that compare the full map artifact
  and empty trace across the shared runtime paths.

## Consequences

### Positive

- **POS-001**: Windowed and headless Floor 5 boot now use the same
  `ScenarioDefinition` configure/run-stats path, reducing split-brain risk.
- **POS-002**: The authored siege layout is deterministic, reachable, and named
  at stable landmarks that later slices can target without consuming shared RNG.
- **POS-003**: The `siegeDirectorSystem` boundary is explicit and narrow, so
  future systems can own waves, Heroes, ram behavior, collision changes, and
  presentation without overloading the phase authority.
- **POS-004**: Regression tests cover manifest/registry plumbing, map
  reachability, RNG isolation, scenario slots, the `siegeDirectorSystem`
  `DEFEAT` transition, and windowed/headless map-plus-trace parity.

### Negative

- **NEG-001**: Floor 5 adds a new floor-specific manifest section and scenario
  module before most gameplay systems exist, so later slices must fill in real
  behavior rather than assuming the skeleton is complete.
- **NEG-002**: Floor 5 has no scenario-AI route yet, so an AI/headless Floor 5
  run has no authored objective ordering to follow until the route lands with
  its runtime wiring.
- **NEG-003**: The abnormal command-post defeat path is represented with the
  existing run-outcome taxonomy until a later slice introduces real defeat
  presentation and telemetry categories.

### Risks

- **RSK-001**: Later slices could drift from the manifest-backed geometry if
  they rederive landmarks independently; they should reuse the existing Floor 5
  map config/layout helpers.
- **RSK-002**: Future breach gameplay must replace the Slice 1 pre-open breach
  seam with an atomic phase/navigation/collision transaction without breaking
  the parity tests.
- **RSK-003**: Adding live waves or Heroes to `siegeDirectorSystem` would violate
  this ADR's authority boundary; those behaviors need separate systems wired
  through real simulation paths.

## Alternatives Considered

### Generic generator with Floor 5 parameters

- **ALT-001**: **Description**: Reuse an existing procedural generator and tune
  room counts, sizes, and labels to approximate the siege path.
- **ALT-002**: **Rejection Reason**: The issue requires an authored Command
  Post-to-throne battlefield with stable landmarks and route semantics; a
  generic generator would make that contract harder to prove and maintain.

### Separate windowed and headless Floor 5 boot paths

- **ALT-003**: **Description**: Add bespoke Floor 5 setup code separately in the
  windowed scene and headless runner.
- **ALT-004**: **Rejection Reason**: That would recreate the split-brain risk the
  scenario contract is meant to prevent. Shared `ScenarioDefinition` slots are
  the existing canonical seam for floor-specific runtime wiring.

### Emit a boot trace entry for the initial phase

- **ALT-005**: **Description**: Record an initial `MUSTER` trace event during
  scenario initialization.
- **ALT-006**: **Rejection Reason**: The hard gate explicitly asks for the same
  empty deterministic phase trace. The initial phase is stored in state, but
  normal boot emits no trace entries.
