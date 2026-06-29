# ADR 0033: Extract shared math/grid/room-hop utilities and dedupe constants

## Status

Accepted

## Date

2026-06-29

## Estimated Complexity

🍎 x 3 — touches 3 layers (core/engine/game) but behavior-preserving with full UT.

## Context

A codebase-wide refactor review found duplicated math (vector normalize/distance in
`enemyAISystem` + `weaponSystem`), duplicated grid math (index↔coords, flood fill across
`flow-field`/`special-rooms`), a constant copied three times (`DEFAULT_BLOOD_COLOR` in
core/engine), and two inlined room-graph BFS loops inside `floorScenario`. This duplication
slows development and hides pure logic inside large files (~92% covered but hard to test in
isolation). The well-covered core/game/shared layers make consolidation low-risk; the ~0% UT
engine god-classes do not, so they are deferred.

## Decision

Consolidate the duplicated logic into small, tested shared modules: `src/shared/vec.ts`,
`src/core/map/grid-utils.ts`, `src/game/room-hops.ts`, and a single `DEFAULT_BLOOD_COLOR`
in `shared/constants.ts`. Rewire call sites to import these; defer floorScenario/bt-ai/engine
decompositions to follow-up sessions guarded by e2e/probe coverage.

## Consequences

### Positive

- Single source of truth for vector/grid/room-hop math; ~20 new unit tests; −34 LOC in floorScenario.
- Pure helpers are testable without spawning a world; floor1 placement + win-rate gates prove equivalence.

### Negative

- One blood-color constant now spans a core→engine import boundary (already permitted: engine may import core/shared).

### Risks

- Shared helpers are used by hot ECS paths; mitigated by behavior-preserving extraction + green full verify.

## Alternatives Considered

- Leave duplicates in place — rejected, compounds maintenance cost.
- Decompose god-classes now — rejected, engine ~0% UT, needs probe guards first.
