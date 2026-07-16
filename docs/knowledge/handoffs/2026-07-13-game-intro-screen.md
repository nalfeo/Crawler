# Handoff: Game Intro Screen

**Date:** 2026-07-13  
**Session slug:** game-intro-screen  
**Apples:** 🍎🍎🍎 estimated / 🍎🍎🍎 actual (delta 0, verdict: exact)

## Summary

Added a pre-dungeon intro screen that shows a Director welcome message and lets
the player choose their name and gender before entering Floor 1. Skipped
automatically in labs (URL has `?lab=` or path ends with `lab.html`) and
headless/Node.js runs.

## Systems touched

mapgen

## What changed

### New files

- **`src/shared/intro-config.ts`** — Shared constants (`INTRO_DATA_REGISTRY_KEY`,
  `PlayerGender` type, `DEFAULT_PLAYER_NAME`, `DEFAULT_PLAYER_GENDER`) kept in
  `shared/` so engine tests can import without pulling Phaser.
- **`src/engine/scenes/IntroScene.ts`** — Phaser scene. Auto-skips in lab/headless
  contexts via `isLabContext()` (checks `window === undefined`, `?lab=` URL param,
  and `lab.html` pathname). Uses a native HTML `<input>` plus native radio controls
  positioned over the canvas for accessible name + gender entry, cleans them up on
  the Phaser `shutdown` event, applies the live render scale to the intro camera,
  and stores
  `{ playerName, playerGender }` in `game.registry[INTRO_DATA_REGISTRY_KEY]` then
  starts `BootScene`.
- **`tests/unit/intro-scene-wiring.test.ts`** — Source guards covering wiring,
  defaults, shutdown/accessibility, render scale, template replacement, and data
  ordering.
- **`tests/e2e/intro-scene-flow.test.ts`** — Deterministic browser coverage for blank
  name defaulting, trimmed custom names, alternate gender selection, registry
  hand-off, scene transition, and resulting Director commentary.

### Modified files

- **`src/core/world.ts`** — Added `playerName: string` (default `'Rhea Vale'`) and
  `playerGender: 'female' | 'male' | 'other'` (default `'female'`) to `GameWorld`.
- **`src/bootstrap/floor-game-config.ts`** — Added `new IntroScene()` as the first
  scene before `BootScene`. Labs auto-skip via URL detection.
- **`src/engine/index.ts`** — Exports `IntroScene` and `PlayerGender`.
- **`src/game/scenarioDefinitions.ts`** — `FLOOR_1_DIRECTOR.intro` now uses
  `{playerName}` template (was hardcoded `'Rhea Vale'`).
- **`src/engine/scenes/MainGameScene.ts`** — Reads intro registry data after
  `createGameWorld()` and **before** `configureWorld()` so scenario initializers
  see the chosen name. `queueDirectorCommentary()` substitutes `{playerName}` via
  a replacer callback so `$` sequences in player names stay literal.
- **`src/game/floorScenario.ts`** — `protagonistName` now set from `world.playerName`
  instead of `floor1Config.protagonist`.
- **`tests/game/floor1-game-config.test.ts`** — Updated scene-list assertion for
  `new IntroScene()`.

## Design decisions

- **URL-based skip** (`isLabContext`): labs use `lab.html?lab=<id>` so the check
  fires without per-lab call-site changes. Headless (Node.js) skips via
  `typeof window === 'undefined'`.
- **Native DOM form controls**: Phaser DOM plugin requires explicit game config
  opt-in; positioned DOM controls are simpler, screen-reader accessible, and clean
  up through the Phaser `shutdown` lifecycle hook.
- **Registry hand-off**: `game.registry` is the standard Phaser inter-scene data
  bus; no global mutable module state needed.
- **Apply intro data before `configureWorld`**: ensures `initializeFloor1Scenario`
  reads `world.playerName` (which sets `floorScenario.protagonistName`) correctly.
- **Global regex for template substitution**: `/{playerName}/g` replaces all
  occurrences; the callback form preserves literal `$` sequences in player names.

## Known limitations

- HTML `<input>` position is computed once at creation; window resize during the
  intro could misalign it. Acceptable: the intro is brief and most users confirm
  immediately. A future polish pass could recompute on `scale.resize`.

## Review ledger

`docs/knowledge/review-ledgers/2026-07-13-game-intro-screen.review-ledger.json`  
3🍎 — plan review (gpt-5.4) + code review (claude-sonnet-4.5) — clean.
