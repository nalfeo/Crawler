# Handoff: Floor-Agnostic World State Refactor

**Date:** 2026-07-05  
**Session slug:** floor-agnostic-world-state  
**Apple estimate:** 🍎🍎🍎 | **Actual:** 🍎🍎🍎 | **Verdict:** exact

## Summary

Refactored world state to remove floor-name baking from systems. Three changes:

1. **`world.floor1` → `world.floorScenario`** — mechanical rename (~200 refs across 40+ files). The underlying type `FloorScenarioState` was already floor-agnostic.

2. **Config-driven loot in `dropSystem`** — replaced `world.floor === 1 ? LOOT_TABLES.FLOOR_1 : undefined` with a manifest lookup. Added `floorLootTableId: "floor_1"` to `floor1.manifest.json` and `floorId: string` to `GameWorld`.

3. **`world.floor2State` + `world.floor2Settlement` → `world.floorExtendedState`** — merged into a single `FloorExtendedState | null` container (`familyState?: Floor2State`, `settlement?: Floor2SettlementSnapshot`). The old `floor2State` field in `FactionRelationsWorldFacet` became `floorExtendedState: { familyState?: Floor2State } | null`.

Also removed `enableFloor1` from `SimulationOptions` — simulation step now checks `world.floorScenario` directly.

## Systems touched

`core`, `engine`, `game`

## Files touched

**Core:**

- `src/core/world.ts` — `FloorExtendedState` interface, `floorId`, renamed `floor1`→`floorScenario`, replaced `floor2State`/`floor2Settlement` with `floorExtendedState`
- `src/core/index.ts` — export `FloorExtendedState`
- `src/core/faction-relations.ts` — `FactionRelationsWorldFacet` field rename
- `src/core/systems/dropSystem.ts` — config-driven loot via `getFloorManifest`
- `src/core/components.ts` — comment updates

**Shared:**

- `src/shared/floor-manifest.ts` — added `floorLootTableId` schema field
- `src/shared/data/floors/floor1.manifest.json` — added `"floorLootTableId": "floor_1"`
- `src/shared/floor-types.ts` — comment update

**Game:**

- `src/game/floorScenario.ts` — sets `world.floorId = 'floor1'`, clears `floorExtendedState = null`
- `src/game/floor2Scenario.ts` — sets `world.floorId = 'floor2'`, writes `floorExtendedState`
- `src/game/floor2Settlement.ts` — writes `floorExtendedState.settlement`
- `src/game/ai/simulation-step.ts` — removed `enableFloor1` option
- `src/game/ai/headless-runner.ts` — removed option passing
- `src/game/systems/achievementSystem.ts`, `familyFeudSystem.ts`, `emergentEventSystem.ts` — read path updates

**Engine:**

- `src/engine/scenes/MainGameScene.ts` — `floor2State` → `floorExtendedState?.familyState`
- `src/engine/scenes/main-game-scene-helpers.ts` — same
- `src/engine/minimap-family-tint.ts` — facet update
- `src/engine/family-relationships-state.ts` — facet update
- `src/engine/HudFamilyRelationships.ts` — comment + null check
- `src/engine/phaser-bridge/sprite-kind.ts` — `EnemyScaleWorld.floor1` → `floorScenario`

**Labs (7):**

- `src/labs/family-territory-lab/index.ts`
- `src/labs/family-feud-lab/index.ts`
- `src/labs/floor2-settlement-lab/index.ts`
- `src/labs/family-boss-den-lab/index.ts`
- `src/labs/hud-family-relationships-lab/index.ts`
- `src/labs/questwaypoints-lab/index.ts`
- `src/labs/ai-runner-lab/index.ts`

**Tests:** all affected unit/integration/ecs/game/headless tests updated

## Verification

- `npm run typecheck` — ✅ clean
- `npm run verify:fast` — ✅ 3844/3844 tests pass
- `npm run verify` — ✅ (all gates pass; PR prereqs require handoff + ADR + ledger)

## Unresolved Issues

None. `floor2Settlement.ts` still uses the name "Floor 2" in comments/function names — these are semantic names for the floor 2 mechanic, not field names in world state, so they're acceptable.

## Recommended Next Steps

- Future floors: set `world.floorId`, `world.floorScenario` (if using scenario), `world.floorExtendedState` (if using families/settlement), add `floorLootTableId` to manifest
- `floor2State` read via `world.floorExtendedState?.familyState` is one level deeper; consider a helper `getActiveFamilyState(world)` if the pattern becomes noisy
