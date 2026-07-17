# Handoff: Combat Arena Lab (Issue #1242)

**Date:** 2026-07-17
**Session slug:** combat-arena-lab
**Apple estimate:** 3🍎

## Summary

Implemented a full-engine combat sandbox lab (`src/labs/combat-arena-lab/`) for debugging AI behavior and playtesting encounters (especially bosses). The lab runs headlessly and visually in-browser, with room geometry presets, enemy presets filterable by floor, a custom mob placement mode (click-to-place), player modes, and simulation speed controls.

## Systems touched

labs, enemy-packs, ai

## What was built

### `src/labs/combat-arena-lab/index.ts` (~900 lines)

**Room Geometry Presets** (5 presets, exported as `ARENA_ROOM_PRESETS`):

- `boss-arena` — 34×24 tiles, wide open with small walls
- `small-room` — 16×14 tiles, tight quarters
- `columns-room` — 28×20 tiles, 4 stone pillars blocking LOS
- `corridor` — 34×8 tiles, narrow with mid-wall break
- `cave` — 26×18 tiles, irregular BiomeType.CAVE with rock scatter

Each preset implements `buildMap(): FloorMap` (TileMap + RoomGraph + terrain Uint8Array) and `playerSpawnTile: {x, y}`.

**Enemy Presets** (exported as `ARENA_ENEMY_PRESETS`):

- Floor 1: `f1-mixed` (2 rats + 2 slimes), `f1-rats` (5 rats), `f1-slimes` (4 slimes), `f1-boss` (boss + guards)
- Floor 2: one preset per family, dynamically generated from `floor2EnemyPack` (18+ families × boss + 2 trash)
- `custom` blank preset (entries=[])

**Custom Mob Placement Mode:**

- `customModeActive` toggle enables click-to-place
- Phaser pointer events + `camera.getWorldPoint()` translate screen→world
- `customMobId` dropdown selects which archetype from `ALL_ARCHETYPES`

**Player Modes:**

- `hero` — normal HP (100), full combat
- `observer` — large HP (9999), fights but effectively immortal
- `immortal` — HP locked to max each frame, can be killed in one shot but it resets

**Simulation Speed:**

- Accumulator pattern: `accumulator += delta * speedMultiplier` with `MAX_STEPS_PER_FRAME = 32`
- Speed options: 1x / 4x / 16x
- `togglePause()` + `stepFrame()` (single-frame advance)

**Exports for headless use:**

- `ARENA_ROOM_PRESETS`, `ARENA_ENEMY_PRESETS`, `ALL_ARCHETYPES`, `spawnFromArchetype(world, x, y, archetype)`

### `src/lab-main.ts`

Added `'combat-arena-lab': '/src/labs/combat-arena-lab/index.ts'` to `LAB_MODULE_PATHS`.

### `tests/unit/combat-arena-lab-wiring.test.ts`

15 tests covering:

- Lab registration in lab-main.ts
- LAB_ID declaration
- Room preset coverage (5 ids)
- Enemy preset floor coverage (floor1 + floor2)
- Custom placement mode wiring
- Speed controls wiring
- Player modes wiring
- Floor filter + preset dropdown wiring
- Headless spawn: floor1 rat pack has valid entries
- Headless spawn: floor2 boss archetypes have familyId
- Headless spawn: spawnBehaviorEnemy + setComponent creates entity with correct HP/position

Tests follow the `readFileSync` + string assertion pattern (no direct Phaser imports), plus direct core API tests for headless simulation.

## Files touched

- `src/labs/combat-arena-lab/index.ts` — new
- `src/lab-main.ts` — +1 line
- `tests/unit/combat-arena-lab-wiring.test.ts` — new
- `docs/knowledge/handoffs/2026-07-17-combat-arena-lab.md` — this file
- `docs/knowledge/review-ledgers/2026-07-17-combat-arena-lab.review-ledger.json` — review ledger

## Verification run

`npm run verify:fast` — ✅ 339 unit + 87 integration test files, all passing.

## Unresolved issues

None.

## Recommended next steps

- Visual validation: open `?lab=combat-arena-lab` in the browser, select a room preset and an enemy preset, verify enemies spawn and fight
- Consider adding floor-3 enemy presets if/when floor3EnemyPack exists
- Consider adding a "wave mode" preset that spawns enemies in waves
- Consider a kill-counter HUD display in the GUI for combat testing metrics
