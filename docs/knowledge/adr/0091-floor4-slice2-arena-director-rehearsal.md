# ADR 0091: Floor 4 Slice 2 — Arena Director Rehearsal

## Status

Accepted

## Date

2026-08-24

## Context

Floor 4 slice 1 shipped the authored Main Event venue, but Floor 4 still had no runtime
phase authority. The Floor 4 epic spec calls slice 2 the first system-bearing slice:
`arenaDirectorSystem`, the arena clock, real-pipeline wiring, RunStats timeline evidence,
and a minimal headless traversal.

This crosses multiple layers:

- shared manifest/schema/state contracts;
- core `GameWorld` extended-state shape;
- game scenario initialization and system wiring;
- headless/human RunStats collection;
- lab/test discoverability.

ADR 0090 already establishes the final architecture. This ADR records the slice-level
implementation compromise needed before waves, Headliners, Green Room shops, HUD, and the
real intermission transaction exist.

## Decision

Implement slice 2 as an **empty broadcast rehearsal**:

1. Floor 4 stores `floor4Arena` state in `world.floorExtendedState`, with a phase union,
   `arenaElapsedMs`, `phaseElapsedMs`, `lastWorldElapsedMs`, and an append-only transition
   timeline.
2. `arenaDirectorSystem` is the single phase authority and is wired through
   `ScenarioDefinition.afterSpawnerSystems`, so `createFloorMainSceneOptions()` injects it
   into both visual and headless simulation paths.
3. The arena clock derives its delta from `world.elapsedMs - lastWorldElapsedMs`, updates
   `lastWorldElapsedMs` every tick, advances only in `WAVES` and `HEADLINE`, and clamps to
   authored absolute wave/act marks.
4. Because slice 3/4/5 content does not exist yet, headline windows start cleared and
   intermissions auto-advance after a short deterministic hold. This is documented as a
   temporary slice-2 deviation in `.specify/specs/floor4-arena.md`.
5. Headless termination uses the existing scenario outcome contract:
   `scenario.getRunOutcome(world)`, rather than adding a Floor-4-specific branch or creating
   a fake Floor-1-style `floorScenario`.
6. RunStats carries `floor4Arena` clock/timeline evidence for both headless and human runs.
7. `floor4-arena-lab` exposes deterministic stepping for the new system.

## Alternatives considered

- **Wait for waves/headliners/shops before adding the phase machine.** Rejected: later
  slices need a real timeline and headless traversal to validate against, and delaying the
  phase authority would force slice 3+ to combine unrelated concerns.
- **Use fixed-step frame count instead of `world.elapsedMs` deltas.** Rejected:
  `world.elapsedMs` is the existing canonical deterministic time accumulator consumed by
  both real and headless pipelines; using it keeps the arena clock additive rather than a
  parallel timing model.
- **Terminate Floor 4 headless runs through a hard-coded runner branch.** Rejected:
  scenario definitions already own terminal outcome selection. Calling `getRunOutcome`
  makes the runner more generic and keeps Floor 4 completion policy in the scenario layer.

## Consequences

Positive:

- Slice 2 is observable in a real headless artifact: an empty Floor 4 run reaches `VICTORY`
  with a deterministic phase timeline.
- The new system satisfies the real-pipeline wiring guard instead of being lab-only.
- The timeline gives later wave, Headliner, Green Room, HUD, and balance slices a stable
  measurement surface.

Risks / follow-ups:

- The auto-advance intermission path is intentionally temporary. Slice 5 must replace it
  with the real Green Room transaction and final stair interaction.
- `OVERTIME` and Headliner defeat latches are represented in the phase type but are not yet
  exercised by runtime content; slice 4 owns those behaviors.
- Slice 3 must consume the existing `FloorMap.feedGates` contract for wave release rather
  than re-deriving arena geometry.
