# Handoff: Combat Arena Lab (Issue #1242)

**Date:** 2026-07-17
**Session slug:** combat-arena-lab
**Apple estimate:** 3🍎

## Summary

Implemented a full-engine combat sandbox lab (`src/labs/combat-arena-lab/`) for debugging AI behavior and playtesting encounters (especially bosses). The lab runs headlessly and visually in-browser, with room geometry presets, enemy presets filterable by floor, a custom mob placement mode (click-to-place), player modes, and simulation speed controls.

## Systems touched

labs, enemy-packs, ai

## What was built

### `src/labs/combat-arena-lab/arena-data.ts` (~449 lines, Phaser-free)

Pure data module safe to import in Node/headless tests. Contains:

**Room Geometry Presets** (5 presets, exported as `ARENA_ROOM_PRESETS`):

- `boss-arena` — 34×24 tiles, wide open with small walls
- `small-room` — 16×14 tiles, tight quarters
- `columns-room` — 28×20 tiles, 4 stone pillars blocking LOS
- `corridor` — 34×8 tiles, narrow with mid-wall break
- `cave` — 26×18 tiles, irregular BiomeType.CAVE with rock scatter

Each preset implements `buildMap(): FloorMap` (TileMap + RoomGraph + terrain Uint8Array) and `playerSpawnTile: {x, y}`.

**Enemy Presets** (exported as `ARENA_ENEMY_PRESETS`):

- Floor 1: `f1-mixed` (2 rats + 2 slimes), `f1-rats` (5 rats), `f1-slimes` (4 slimes), `f1-boss` (real boss via `spawnFloor1BossesArena` — full canonical HP/speed/contact-damage/aggro/fireCooldown config)
- Floor 2: one preset per family, dynamically generated from `floor2EnemyPack` (18+ families × boss + 2 trash)
- `custom` blank preset (entries=[])

**Spawn helpers:** `spawnFromArchetype` (production-representative wiring, `attackRange = detectRange × 0.65` for ranged, `FamilyMembership` for floor-2), `findWalkablePosition` (validates against FloorMap.isPassableAt, tries 8 neighbors → 16 random interior → map center fallback), `spawnPresetAroundCenter`.

### `src/labs/combat-arena-lab/index.ts` (~602 lines)

Thin Phaser scene wrapper:

**Player Modes:**

- `hero` — normal HP (200), full combat
- `observer` — large HP (5000), fights but effectively immortal
- `immortal` — `Invincible` component attached so `healthSystem` never processes damage and can never set `world.state='game_over'`

**Simulation Speed:**

- Accumulator pattern: `accumulator += delta * speedMultiplier` — paused check is at the top of `update()` (before accumulation), preventing backlog at all speeds
- Speed options: 1x / 4x / 16x; `togglePause()` + `stepFrame()` (temporarily sets state to 'playing' for one tick, then restores)
- Terrain rendered via `buildTerrainLayer(this, this.world.floorMap)`, RT depth -20, camera bounds set

**Seed display:** `seedCtrl` stores the lil-gui controller; `onSeedChanged` callback refreshes it immediately when `create()` auto-generates the seed; `newSeed` calls `seedCtrl.updateDisplay()` before respawning.

### `src/lab-main.ts`

Added `'combat-arena-lab': '/src/labs/combat-arena-lab/index.ts'` to `LAB_MODULE_PATHS`.

### `tests/unit/combat-arena-lab-wiring.test.ts`

32 tests covering:

- Lab registration in lab-main.ts and LAB_ID declaration
- Room preset coverage (5 IDs), enemy preset floor coverage (floor1 + floor2)
- Custom placement mode, speed controls, player modes wiring
- Floor filter + preset dropdown wiring
- `archetypeToAiType` correctness for ranged/melee
- `findWalkablePosition` snaps walls, preserves walkable positions
- `spawnFromArchetype` HP/position/attackRange assertions
- **Headless integration**: creates room + player + f1-rats preset, runs 10 simulation steps via `runCoreSimulationStep(preSystems=[weaponSystem, enemyAISystem])`, asserts no crash and valid HP values

All tests use `createTestWorld` from `tests/helpers/world-factory.ts` (not `createGameWorld` directly).

## Files touched

- `src/labs/combat-arena-lab/arena-data.ts` — new (Phaser-free data module)
- `src/labs/combat-arena-lab/index.ts` — new (Phaser scene, ~602 lines); `__arenaReady` flag for E2E probe
- `src/lab-main.ts` — +1 line
- `tests/unit/combat-arena-lab-wiring.test.ts` — new (32 tests)
- `tests/e2e/combat-arena-terrain.test.ts` — new (E2E visual terrain-render guard)
- `docs/knowledge/handoffs/2026-07-17-combat-arena-lab.md` — this file
- `docs/knowledge/review-ledgers/2026-07-17-combat-arena-lab.review-ledger.json` — review ledger

## Verification run

`npm run verify:fast` — all tests passing. Headless integration test confirmed arena pipeline is functional without Phaser.

**Visual/runtime evidence (Rule 9):** `tests/e2e/combat-arena-terrain.test.ts` — boots the real lab in a headless Chromium/WebGL session, waits for `window.__arenaReady` (set at end of `ArenaScene.create()`), screenshots the canvas, and asserts ≥1% non-background pixels in the center region. A missing `buildTerrainLayer` call would produce 0% (solid background). The `__arenaReady` flag is set after `buildTerrainLayer`, `bridge.sync`, and all scene setup, so the test deterministically observes the after-state of the terrain rendering fix.

## Unresolved issues

None.

## Recommended next steps

- Consider adding floor-3 enemy presets if/when floor3EnemyPack exists
- Consider adding a "wave mode" preset that spawns enemies in waves
- Consider a kill-counter HUD display in the GUI for combat testing metrics
