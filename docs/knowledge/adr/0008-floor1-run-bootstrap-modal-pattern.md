# ADR 0008: Run Bootstrap Pattern with Modal-Paused Game Flow

## Status

Accepted

## Date

2026-06-08

## Context

Floor 1 (the tutorial vertical slice) requires a coordinated startup flow:

1. Player enters the game and must select a starter weapon from 3 randomly seeded options.
2. The game state machine must pause and allow modal interaction before the main game loop begins.
3. Decisions about where to place this logic affect at least three architectural layers: `src/core` (ECS state), `src/engine` (Phaser rendering), and `src/game` (high-level game flow).

Previous approaches considered:

- Putting modal logic directly in `MainGameScene.update()` → couples Phaser rendering to game state; harder to test independently.
- Deferring modal until after first frame → causes visual stutter and confusion about when the player can act.

## Decision

We implement a **reusable run bootstrap layer** (`src/game/<floorN>Scenario.ts`) that owns all run-level state transitions and coordinates with the Phaser bridge to pause the game loop:

### Three-Layer Architecture

1. **Game Layer** (`src/game/floorScenario.ts`): Owns run state machine (intro → loadout → playing → win/fail). State transitions are side-effect-free; scenario emits deterministic events (e.g., `onLoadoutDone`, `onObjectiveComplete`) that the bridge consumes.

2. **Engine Layer** (`src/engine/ModalPickerUI.ts`): Receives events from scenario, renders Phaser modal UI, and pauses the game by not calling `update()` on the game world until modal resolves.

3. **Shared Layer** (`src/shared/modal-picker.ts`): Pure modal picker state machine (3-option seeded selection, choice resolution). No rendering or engine knowledge; can be tested in isolation.

### How It Works

- `MainGameScene` accepts an optional `ModalPickerScenario` at bootstrap.
- Before the game loop runs, the scenario emits a `loadout` event.
- The engine layer intercepts this event and shows the modal; the world update loop is paused.
- When the player selects a weapon, the modal resolves, scenario advances to `playing` state, and the world loop resumes.
- All random selection uses `SeededRandom`; no `Math.random()`.

## Consequences

### Positive

- **Testable in isolation**: Scenario state machine can be unit tested without Phaser.
- **Deterministic**: All RNG seeded; replays are guaranteed to match.
- **Reusable pattern**: Future floors can pass their own scenario; same bootstrap infrastructure.
- **Pause-by-side-effect**: Pausing is a consequence of the modal event, not explicit pause logic; keeps game loop deterministic.
- **Clear ownership**: Scenario owns _what_, modal UI owns _how_, shared code owns pure selection logic.

### Negative

- **Three-layer coordination**: Developers must understand flow across core → engine → game layers.
- **Event-driven coupling**: Scenario and engine communicate via events; harder to trace than direct calls (mitigated by clear event types).

### Risks

- **Scenario state drift**: If scenario state is not properly tested, divergence between expected and actual state could cause soft failures (e.g., weapon not actually equipped). **Mitigated by:** comprehensive integration tests in `tests/game/floor1-scenario.test.ts` and test-world helpers that verify both state and side effects.

## Alternatives Considered

1. **Modal before ECS world creation**: Would require full scene reload after modal; wastes resources and makes replays harder to reason about.
2. **Explicit pause flag in world**: Simple to understand, but every system must check `isPaused` before updating, increasing coupling and error surface.
3. **Scene-level state machine in Phaser**: Keeps all logic in one place, but ties game logic to Phaser API, making it harder to port or test without a scene.
