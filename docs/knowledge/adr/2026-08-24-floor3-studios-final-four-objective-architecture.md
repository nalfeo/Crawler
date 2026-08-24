# ADR: Floor 3 Studio/Final Four objective architecture

## Status

Accepted

## Date

2026-08-24

## Context

Floor 3 already had biome-overworld generation and ambient wild spawns, but no deterministic win path. The next slice needed to add six seeded Studio encounters, a gated Final Four roster, and a canonical victory/stairs progression while preserving deterministic simulation behavior and existing shared scenario presentation contracts.

This slice spans shared floor data, core companion/team helpers, and game-layer scenario/objective + AI behavior, so a cross-system decision record is required.

## Decision

- Author Studio and Final Four candidate rosters as shared data (`src/shared/data/floor3/studios.ts`) and derive run-time selections via seeded shuffle (6-of-10 Studios, 4-of-7 Final Four handlers).
- Represent Floor 3 encounter progression in `world.floorExtendedState.floor3Studios` with explicit Studio/Final-Four defeat latches plus staircase lifecycle fields.
- Keep objective authority in `floor3ObjectiveTick`:
  - latch Studio defeats when all encounter teams are simultaneously KO'd,
  - unlock/spawn Final Four when all Studios are defeated,
  - latch victory and staircase spawn/unlock when Final Four is defeated,
  - keep timeout handling as a separate failure path.
- Add core helpers for non-party roster spawning and encounter-team wipe detection, rather than overloading player-party recruitment semantics.
- Restrict companion rival targeting to local engagement radius and halt ambient wild spawns after Floor 3 victory to prevent cross-map aggro collapse and post-victory loss regression.

## Consequences

### Positive

- Floor 3 now has deterministic seeded progression from overworld exploration to terminal victory state.
- Encounter progression is explicit and testable through shared typed state.
- Companion/team semantics stay consistent between party and non-party rosters.
- Post-victory behavior is stable (no ambient re-threat while exiting).

### Negative / Risks

- Added Floor 3 state shape increases coupling between scenario logic and shared world typing.
- Encounter tuning (levels/roster composition) is intentionally first-pass and may require follow-up balance work.

## Alternatives considered

1. **Embed Studio/Final Four definitions directly in scenario code**
   - Rejected: weaker data-driven reuse/testability and harder content iteration.
2. **Reuse player party recruitment spawn path for Studio/Final-Four rosters**
   - Rejected: party-slot lock/cap semantics are specific to player-owned companions.
3. **Allow ambient wild director to continue post-victory**
   - Rejected: allows avoidable game-over after objective completion and conflicts with expected exit flow.
