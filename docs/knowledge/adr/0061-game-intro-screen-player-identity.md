# ADR 0061: Game Intro Screen — Player Identity Before Run Start

## Status

Accepted

**Date:** 2026-07-13  
**Deciders:** @nalfeo (maintainer)

## Context

Issue #1100 requires a pre-dungeon intro screen that shows a Director welcome
message and lets players choose their display name and gender. The game is a
crafting-focused reality-show dungeon crawler, so having a "you're on camera"
welcome moment and a brief identity selection fits the theme.

The feature touches three architectural layers:

- **`src/core/`** — `GameWorld` now carries `playerName` and `playerGender`.
- **`src/game/`** — `floorScenario.protagonistName` derives from `world.playerName`
  instead of the static manifest value; director intro text uses a `{playerName}`
  template.
- **`src/engine/`** — New `IntroScene` Phaser scene; `MainGameScene` reads intro data
  from the registry before initializing the world scenario.

Key constraint: the intro must be **skipped automatically** in AI labs and
headless/automated runs without per-call-site changes.

## Decision

**Single Phaser scene (`IntroScene`) with URL-based auto-skip, registry hand-off,
and `{playerName}` template substitution.**

### Data flow

1. `IntroScene.create()` — if `isLabContext()` (checks `window === undefined`,
   `?lab=` URL param, or `lab.html` pathname) → immediately start `BootScene`.
   Otherwise render the intro UI.
2. On confirm → `game.registry.set(INTRO_DATA_REGISTRY_KEY, { playerName, playerGender })` → `BootScene` start.
3. `MainGameScene.create()` — after `createGameWorld()` and **before** `configureWorld()`,
   read from registry and set `world.playerName` / `world.playerGender`.
4. `initializeFloor1Scenario` reads `world.playerName` when constructing
   `floorScenario.protagonistName`.
5. `queueDirectorCommentary()` resolves `/{playerName}/g` from `world.playerName`
   when emitting director lines.

### Shared constants in `src/shared/intro-config.ts`

The registry key, type, and defaults live in `shared/` so unit tests can import
them without transitively pulling Phaser.

## Alternatives considered

### A. DOM overlay before Phaser starts (in `main.ts`)

Show an HTML modal before `new Phaser.Game(...)` is called; collect values into
module-level variables; pass them into the game config.

- ✅ No Phaser scene complexity; native inputs trivially positioned.
- ❌ Only works for the entry point in `main.ts`. Labs use `lab-main.ts` and would
  need separate skip logic. The skip would need to happen in every lab bootstrap
  or be encoded in a shared helper that is easy to forget.
- ❌ Module-level mutable state shared between the "pre-game" phase and the Phaser
  scene is architecturally messier than the registry pattern.

### B. `skipIntro` parameter on `createFloorGameConfig`

Add `{ skipIntro?: boolean }` to `createFloorGameConfig`; labs pass `true`.

- ✅ Explicit opt-out at each call site; no URL detection.
- ❌ Requires 10+ lab call-site updates (all labs that call `createFloorGameConfig`
  or `createFloor1GameConfig`). Prone to new labs forgetting the flag.
- ❌ More API surface change than a scene that self-detects its context.

### C. IntroScene inside `MainGameScene` as a blocking overlay

Show the intro as an overlay within `MainGameScene` before the `loadout` state.

- ✅ Single scene, no registry hand-off.
- ❌ Complicates the existing state machine (`loadout` / `playing` / …).
- ❌ Lab detection still needed.
- ❌ Player identity must be captured before world initialization, so placing it
  inside `MainGameScene` after world creation requires re-initialization — fragile.

## Consequences

### Positive

- No per-lab code changes required; labs auto-skip via their existing URL pattern
  (`lab.html?lab=<id>`).
- Headless Node.js runs skip automatically (no `window` object).
- `world.playerName` is available to all downstream systems (director, HUD, quests)
  from the moment `configureWorld` runs.
- `{playerName}` template pattern can be extended to other director lines without
  schema changes.
- Minimal coupling: `IntroScene` only writes to the registry; it does not touch
  the world directly.

### Negative / Risks

- The HTML `<input>` is positioned once at creation; window resize during the
  (very brief) intro could misalign it. Acceptable trade-off — a full Phaser DOM
  plugin integration would require enabling `dom.createContainer` in the game
  config for a single scene.
- `INTRO_DATA_REGISTRY_KEY` must be consistent between `IntroScene` (writer) and
  `MainGameScene` (reader); a typo would silently fall back to defaults. Mitigated
  by the shared constant in `src/shared/intro-config.ts`.

## Files affected

- `src/shared/intro-config.ts` (new)
- `src/engine/scenes/IntroScene.ts` (new)
- `src/core/world.ts`
- `src/bootstrap/floor-game-config.ts`
- `src/engine/index.ts`
- `src/game/scenarioDefinitions.ts`
- `src/engine/scenes/MainGameScene.ts`
- `src/game/floorScenario.ts`
- `tests/unit/intro-scene-wiring.test.ts` (new)
- `tests/game/floor1-game-config.test.ts`
