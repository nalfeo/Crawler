# Handoff: Unit Test Coverage Pass

**Date:** 2026-07-04  
**Session slug:** coverage-pass  
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** exact

## Systems touched

## What was done

Ran a systematic coverage pass: re-ran `verify:coverage`, sorted files by line coverage, and added targeted tests for real uncovered branches across ~15 files. No production code was changed.

### Files created

- `tests/unit/weapon-skills.test.ts` — `isWeaponClassSkillId`, `isWeaponTypeSkillId`
- `tests/unit/harvestable-defs.test.ts` — `getHarvestableDef`, `getHarvestableDefByIndex`

### Files extended

- `tests/unit/loot-tables.test.ts` — `getLootTable` branches
- `tests/unit/family-data-schemas.test.ts` — cache-hit + `_reset`
- `tests/unit/floor1-config.test.ts` — error path, deprecated compat
- `tests/unit/inventory.test.ts` — `maxStack ≤ 0` error branch
- `tests/ecs/pathfinding.test.ts` — OOB + more `findTilePath` edge cases
- `tests/unit/render-scale.test.ts` — `readDevicePixelRatio` DOM + `resolveBootRenderScale`
- `tests/ecs/trap-system.test.ts` — safe-room owner skip
- `tests/game/room-hops.test.ts` — dangling-neighbor BFS guard
- `tests/game/weapon-equipping.test.ts` — `clearActiveWeaponDef` no-op
- `tests/unit/random.test.ts` — `SeededRandom.pick` empty-array throw
- `tests/game/auto-progression-npc.test.ts` — 5 `autoFloor1ProgressionSystem` branches
- `tests/unit/emergent-event-scheduler.test.ts` — `regionEnter` trigger
- `tests/unit/generate-shop-inventory.test.ts` — `getShopArchetype` known/unknown
- `tests/ecs/statusEffectSystem.test.ts` — orphaned-entity cleanup (lines 35-36)
- `tests/ecs/safe-room.test.ts` — `isEntityInSafeSpace` undefined-position

## Test count

3692 tests passing (up from ~3620 before this session).

## Notes

- `loadFloorManifest` is a private (non-exported) function — the throw-on-unknown-floor branch (line 179) is dead code from tests; left uncovered intentionally.
- `src/engine/**` is Phaser UI — 0% coverage is expected and intentional.
- 0% files like `biome-tags.ts`, `floor-types.ts`, `quest-events.ts` are pure type files with no runtime logic.
- `equipmentDefs.ts` IIFE static validation lines are unreachable from unit tests (run at module load only).

## What remains

- `knockbackSystem` flying-bounds paths (~84.5%) — straightforward but time ran out
- `familyFeudSystem` (~89.5%) branches
- `abilitySystem` (~90.4%) error-throw paths for unknown/wrong-kind ability
- `skillSystem` — `bonus=0` skip + `applyMilestone` missing def/milestone
