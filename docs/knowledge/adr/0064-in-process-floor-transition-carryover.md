# ADR 0064: In-Process Floor Transition Carryover

## Status

Accepted

## Date

2026-07-17

## Estimated Complexity

🍎 x 4 — coordinates scene lifecycle, floor initialization, progression state, and deterministic regression coverage.

## Context

Floor 1 completion displayed a Floor 2 transition message, then performed a full
browser navigation. The new page replayed the intro and created a direct-start
Floor 2 player, replacing the completed run's level, stats, inventory, equipment,
gold, skills, abilities, and health.

The transition must create a fresh Floor 2 world so Floor 1 entities, timers,
quests, and map state cannot leak. It must also preserve the player's run-wide
progression and initialize Floor 2's settlement-to-Broker objective chain exactly
once. The engine layer cannot import game-layer floor logic.

## Decision

- **DEC-001**: Floor transitions restart the existing `MainGameScene` in process.
  The scene invokes an injected completion callback with the completed world and
  player entity, accepts the returned next-floor options, and restarts itself.
- **DEC-002**: The game layer owns a value-only `PlayerCarryoverSnapshot`. It
  captures run-wide player identity, level, base/core stats, health, score, gold,
  inventory, equipped item IDs, skills, abilities, persistent skill/ability
  modifiers, feature unlocks, and achievements.
- **DEC-003**: Floor-local entities, quests, goal flags, maps, timers, temporary
  buffs, and floor modifiers are not carried. Floor 2 creates these from its own
  deterministic initializer.
- **DEC-004**: Floor 2 has two entry policies. Direct starts retain the level-5
  baseline, starter gear, and default spell. Carryover starts skip those mutations
  and restore the snapshot after Floor 2 environment/objective initialization but
  before the scene's first render or simulation sync.
- **DEC-005**: Bootstrap composes the next Floor 2 options and updates browser
  history without using the URL, browser storage, or a global singleton as the
  state transport.
- **DEC-006**: Hosts that layer behavior over base floor options can provide a
  recomposition callback. The scene applies it to next-floor base options before
  restart so AI input, recording, and lab presets survive the boundary.

## Consequences

### Positive

- **POS-001**: A new ECS world prevents stale Floor 1 entities and scenario state
  from leaking into Floor 2.
- **POS-002**: Player progression is copied through one deterministic,
  independently testable contract.
- **POS-003**: Intro identity and the launch seed remain in the same Phaser game
  and registry during the transition.
- **POS-004**: Direct Floor 2 starts remain supported without conflating their
  baseline with a completed Floor 1 build.

### Negative

- **NEG-001**: The carryover contract must be extended when new run-wide player
  progression surfaces are added.
- **NEG-002**: `MainGameSceneOptions` now has a recursive transition callback that
  can return replacement options.

### Risks

- **RSK-001**: Omitting a future run-wide field would reset it at a floor boundary.
  Deterministic capture/restore and chained transition tests mitigate this risk.
- **RSK-002**: Restoring floor-local state would contaminate the next floor. The
  snapshot deliberately excludes quest logs, goal flags, maps, and floor modifiers.

## Alternatives Considered

### Mutate the Floor 1 World In Place

- **ALT-001**: **Description**: Replace the Floor 1 map and scenario state inside
  the existing ECS world.
- **ALT-002**: **Rejection Reason**: Existing entities, side maps, timers, queued
  events, and floor-local systems could survive and contaminate Floor 2.

### Browser Storage or Global Singleton

- **ALT-003**: **Description**: Serialize progression to `localStorage`,
  `sessionStorage`, or a module-level singleton before navigation.
- **ALT-004**: **Rejection Reason**: This creates a second source of truth,
  complicates deterministic tests, and introduces stale-state recovery concerns.

### URL Payload and Full Reload

- **ALT-005**: **Description**: Encode player state in the Floor 2 URL and rebuild
  the Phaser game after navigation.
- **ALT-006**: **Rejection Reason**: The payload is large and brittle, replays the
  intro/boot lifecycle, and risks losing identity or seed metadata.

### Synthetic Snapshot for Every Floor 2 Start

- **ALT-007**: **Description**: Convert the direct-start level-5 baseline into a
  synthetic carryover snapshot and route every entry through restore.
- **ALT-008**: **Rejection Reason**: It would obscure the semantic difference
  between a debugging/direct start and a completed prior-floor run without
  improving the production transition.
