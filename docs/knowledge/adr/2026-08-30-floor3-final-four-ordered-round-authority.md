# ADR: Floor 3 Final Four ordered-round authority

## Status

Accepted

## Date

2026-08-30

## Context

Floor 3 selects four Final Four handlers in deterministic seeded order, but the
runtime flattened every selected handler's roster into one simultaneous spawn.
That made one wipe defeat the entire gauntlet and allowed exit without a
deliberate keep-one-companion selection. The correction crosses portable Floor
3 state, game-layer objective progression, real-game stair confirmation, and
headless completion behavior.

## Decision

- Store the selected Final Four as four ordered round records in portable Floor
  3 state. Each record retains the selected handler identity and only that
  handler's pending roster.
- Preserve the array order returned by `selectFloor3FinalFour`; runtime
  progression never re-sorts or re-selects finalists.
- Reuse one Final Four team id for every round, but keep only one handler roster
  present in the ECS at a time.
- Make `floor3ObjectiveTick` the sole round-transition authority. Unlock spawns
  round one; each active-roster wipe advances exactly once; only the fourth
  wipe latches victory and unlocks the stairs.
- Require a currently valid player-party Companion selection before
  `confirmFloor3StairDescend` can transition the floor. Real play uses
  `selectFloor3KeptCompanion`; headless play may explicitly call the
  deterministic game-layer `autoDefaultFloor3KeptCompanion` helper.

## Consequences

### Positive

- Real and headless runtimes share one deterministic four-round state machine.
- Seeded finalist order remains observable and testable.
- No inactive future roster can be targeted, knocked out, revived, or rewarded
  by generic ECS systems.
- Floor completion cannot silently discard the authored keep-one reward choice.

### Negative / Risks

- Final Four presentation consumers must read the active round index instead of
  assuming one flattened pending roster.
- A stale selected entity now blocks descent, intentionally requiring a new
  valid selection rather than producing incomplete carryover.

## Alternatives considered

1. **Give each handler a distinct team id and spawn all four.** Rejected because
   different teams are hostile under Companion targeting and the requirement is
   to reuse one Final Four team identity.
2. **Spawn all four rosters with inactive flags.** Rejected because generic
   combat, KO/recovery, reward, and query paths would all need a second
   activation concept, increasing cross-system coupling.
3. **Auto-select a kept Companion at victory.** Rejected for real play because
   it bypasses the required choice. The deterministic fallback remains an
   explicit game-layer function solely for non-interactive/headless completion.
