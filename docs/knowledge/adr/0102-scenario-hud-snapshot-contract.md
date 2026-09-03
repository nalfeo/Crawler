# ADR 0102: Scenario HUD Snapshot Contract

## Status

Accepted

## Date

2026-09-02

## Estimated Complexity

🍎 x 5 — touches shared presentation contracts, Floor 6 scenario projection, the real scene presenter, and verification coverage.

## Context

Floor 6 Slice 8 requires quest, Director, HUD, audio, VFX, route, site, tower, Relay danger, loot, upgrade, break-safety, and Deadline presentation to reflect authoritative scenario state. The existing `Floor6DefenseRunStats.presentation` snapshot provided deterministic evidence for headless and tests, but the shipped scene presenter only consumed the generic scenario contract for Director, stair marker, loadout, and completion copy.

- **CTX-001**: `src/engine/` cannot import `src/game/`, so a direct `MainGameScene` dependency on Floor 6 helpers would violate layer boundaries.
- **CTX-002**: Floor-specific presentation must not reimplement phase, wave, tower, economy, or victory booleans in the renderer; it must project state from the scenario owner.
- **CTX-003**: The issue requires real-game presentation evidence, not a run-stats-only API that no shipped UI consumes.
- **CTX-004**: Future floors need the same extension seam without adding more floor identity branches to `MainGameScene`.

## Decision

Extend `ScenarioPresentationContract<TWorld>` with an optional `getHudSnapshot(world)` hook returning renderer-neutral `ScenarioHudSnapshot` data: stable snapshot id, display lines, and semantic HUD/audio/VFX cues. Floor 6 implements this hook in `src/game/scenarioDefinitions.ts` by calling `getFloor6DefenseRunStats(world)` and formatting its authoritative `presentation` snapshot. `MainGameScene` consumes only the generic hook, renders the lines in a small live status panel, and dispatches one-shot cue semantics without importing Floor 6 code.

- **DEC-001**: The shared contract owns only semantic strings and cue kinds; Phaser objects, colors, positions, and synthesized audio choices remain in `src/engine/`.
- **DEC-002**: Floor 6 keeps its authoritative state projection in `floor6Scenario.ts`; scenario definitions adapt that projection into the generic presentation shape.
- **DEC-003**: Cues are latched by id in the scene so phase/danger/audio beats do not replay every frame.
- **DEC-004**: Floors without HUD-specific needs leave the hook undefined, preserving existing scenario behavior.

## Consequences

### Positive

- **POS-001**: The real game now consumes Floor 6 presentation through the same scenario-presentation seam as Director and exit copy, satisfying layer boundaries and avoiding floor branches in the engine.
- **POS-002**: HUD/audio/VFX proof remains deterministic because all displayed lines and cue labels derive from `Floor6DefenseRunStats.presentation` and authoritative `Floor6DefenseState`.
- **POS-003**: Future floor-specific HUD panels can reuse the hook without adding `src/game` imports or duplicating scenario state in `MainGameScene`.
- **POS-004**: Unit source-string wiring coverage can guard the cross-layer seam while focused scenario tests validate the semantic content.

### Negative

- **NEG-001**: The generic scenario contract is larger, and renderers must now tolerate an optional live HUD hook in addition to existing Director/stair/loadout/completion hooks.
- **NEG-002**: The first rendering implementation is intentionally text-forward and generic; richer iconography or bespoke layouts still require future UX work.
- **NEG-003**: Audio cue synthesis is deliberately minimal and semantic, so exact sound design is not data-authored yet.

### Risks

- **RSK-001**: If future floors over-pack `lines`, the generic panel could become noisy or overlap other HUD surfaces; follow-up UX should either summarize or add layout-specific constraints.
- **RSK-002**: Cue ids must remain stable within a run. Reusing an id for a different cue would suppress the new cue after the old one latches.
- **RSK-003**: Scenario HUD snapshots must stay derived from authoritative state; adding renderer-only floor booleans would reintroduce split-brain presentation.

## Alternatives Considered

### Floor-specific MainGameScene branch

- **ALT-001**: **Description**: Add `if (world.floorId === 'floor6')` logic in `MainGameScene` to import and call Floor 6 helpers directly.
- **ALT-002**: **Rejection Reason**: This violates the engine/game layer boundary and repeats the floor-identity branching the scenario-presentation contract was created to avoid.

### RunStats-only presentation evidence

- **ALT-003**: **Description**: Leave Floor 6 presentation in `Floor6DefenseRunStats.presentation` and validate it only through headless/unit tests.
- **ALT-004**: **Rejection Reason**: This proves deterministic data exists but not that the shipped game presents it, so it fails the real-game HUD/audio/VFX requirement.

### Quest-objective labels only

- **ALT-005**: **Description**: Depend on the existing quest tracker and Director milestones to communicate Floor 6 status.
- **ALT-006**: **Rejection Reason**: The quest tracker cannot express route directions, build-site occupancy, tower ranges/tiers, Relay danger, loot, upgrade choices, service-break safety, and Deadline escalation together without reimplementing floor-specific state in quest objectives.

### Bespoke Floor6HudUI component

- **ALT-007**: **Description**: Create a dedicated Floor 6 renderer component under `src/engine/` with custom layout, effects, and sound routing.
- **ALT-008**: **Rejection Reason**: A bespoke component is larger than needed for this slice and still requires a generic contract seam to preserve layer boundaries; it can be introduced later as a richer consumer of the same snapshot.
