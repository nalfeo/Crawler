# ADR 0082: Floor 3 Companion Kickoff Contract

## Status

Accepted

## Date

2026-08-30

## Estimated Complexity

🍎 x 3 — touches Floor 3 scenario logic, shared NPC/UX data, headless-runner telemetry, and real-scene/headless tests.

## Context

Floor 3 was not reliably playable from the player-facing transition path. A player could enter Floor 3 with no clear introduction or explanation, and the safe-room door flow depends on the player receiving a first companion before progression can continue. The issue specifically required a Professor Oak-like NPC/event to handle that first companion selection.

The implementation also had to preserve real-player mechanics. Both the shipped `MainGameScene` and headless AI runner already use `ScenarioDefinition.selectLoadoutOption` for floor loadout pauses, so companion selection must stay on that scenario contract instead of introducing test-only grants, fake abilities, or hooks unavailable to a real player.

Floor 3 has an additional spawning constraint: mobs cannot spawn inside safe rooms. Its manifest can make the entrance spawn room safe through floor behavior even when the structural room role is `SPAWN`, so shared ambient-spawn helpers that only reject generic safe roles can still return an unsafe Floor 3 candidate unless Floor 3 applies its own protected-room filter.

## Decision

Use a real Floor 3 NPC, Professor Thistle, as the explicit Professor Oak-like onboarding host while keeping the companion grant on the existing scenario loadout contract. `initializeFloor3Scenario` spawns `floor3-companion-professor` near the player in the entrance room, and `src/shared/floor3-ux.ts` frames the intro and starter picker as Professor Thistle's companion briefing.

The scenario continues to pause in `world.state === 'loadout'` until `selectFloor3LoadoutOption` is invoked. `MainGameScene` presents that loadout to real players, and the headless runner auto-selects through the same `scenario.selectLoadoutOption` hook. The runner now logs a structured `control` event whenever it auto-selects a loadout option so AI-runner JSONL logs prove the real selection path executed.

Floor 3 ambient spawning now post-filters candidates returned by the shared ambient spawn resolver through Floor 3's own protected-room predicate before accepting them. This preserves shared spawn logic for ordinary candidates while preventing mobs from spawning in the Floor 3 entrance/safe room.

## Consequences

### Positive

- **POS-001**: Floor 3 now has an explicit in-world Professor NPC and Professor-hosted onboarding copy instead of an unexplained modal-only transition.
- **POS-002**: The initial companion pick remains on the same scenario contract used by the real scene and headless runner, avoiding fake test-only powers or divergent AI behavior.
- **POS-003**: AI-runner event logs now contain deterministic evidence that Floor 3 loadout selection ran through `scenario.selectLoadoutOption`.
- **POS-004**: Ambient Floor 3 mobs no longer accept shared resolver candidates inside protected safe-room tiles.

### Negative

- **NEG-001**: Floor 3 initialization now owns one more colocated NPC entity and placement rule, which adds a small amount of scenario-specific state.
- **NEG-002**: The Professor event is represented by NPC presence plus the existing blocking loadout modal rather than a fully manual conversation interaction, so the event is explicit but not a separate pre-loadout quest step.

### Risks

- **RSK-001**: If future floors reuse shared ambient spawning while adding floor-specific protected rooms, they may need similar post-filtering or a shared protected-room spawn contract.
- **RSK-002**: If Floor 3 entrance maps become extremely constrained, Professor Thistle can be skipped when no non-player passable spawn-room tile exists; normal generated Floor 3 maps are covered by tests.

## Alternatives Considered

### Require Manual NPC Conversation Before Companion Selection

- **ALT-001**: **Description**: Spawn an NPC and require the player to walk to and interact with the NPC before opening the starter companion picker.
- **ALT-002**: **Rejection Reason**: This would add a new pre-loadout movement dependency inside the same safe-room-door deadlock being fixed. It also risks diverging from the existing scenario loadout contract used by `MainGameScene` and the headless runner.

### Modal-Only Professor Copy Without an NPC Entity

- **ALT-003**: **Description**: Change only `src/shared/floor3-ux.ts` copy so the starter modal mentions a professor, without adding a real NPC to the world.
- **ALT-004**: **Rejection Reason**: The issue explicitly asked for a Professor Oak-like NPC/event. Copy alone would not provide an in-world Professor NPC for visual verification or player orientation.

### Change the Shared Ambient Spawn Resolver Globally

- **ALT-005**: **Description**: Make the generic `resolveAmbientSpawnPoint` reject every spawn room or every safe-by-behavior room for all floors.
- **ALT-006**: **Rejection Reason**: The bug is Floor 3-specific because its entrance room is safe via manifest behavior while structurally marked as `SPAWN`. A global rule could unintentionally change other floors' spawn behavior; Floor 3-specific post-filtering is the smaller and safer fix.
