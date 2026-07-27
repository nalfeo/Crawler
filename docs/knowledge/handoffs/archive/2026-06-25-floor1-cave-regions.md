# Handoff: Floor 1 cave regions

**Date:** 2026-06-25  
**Persona:** Producer / Systems Engineer  
**Apple estimate:** 🍎🍎🍎 (estimated), 🍎🍎🍎🍎 (actual), verdict 📉 under

## Summary

- Added cave-region support to `DungeonGenerator` via new `caveRegions` option.
- Enabled cave regions for `BiomeType.BASIC_UNDERGROUND` in generator registry (Floor 1 biome path).
- Implemented deterministic cave shaping with curved/non-linear paths and non-uniform cave chambers.
- Cave shaping uses a dedicated `SeededRandom` stream derived from map seed/dimensions to avoid perturbing core generator RNG flow.
- Added tests to validate cave-region behavior and Floor 1 biome wiring.
- `pruneInaccessibleDoors` scoped inside the `caveRegions` block so it only runs when cave carving is active.
- Reverted undocumented scope-creep changes: floor1 map dimensions (kept at 120×70), room ranges/maxRooms/floorDensity, corridor-widening rate (~60%), diagonal-shortcut rate/thresholds, CaveGenerator `DEFAULT_CAVE_OPTIONS`.

## Files changed

- `src/core/map/generators/DungeonGenerator.ts`
- `src/core/map/generators/registry.ts`
- `src/game/floor1Scenario.ts` — more robust `resolveBossSpawnPosition` fallback (spiral search)
- `tests/ecs/map-generators.test.ts`
- `tests/unit/floor1-config.test.ts` (unchanged from base)
- `src/shared/data/floors/floor1.manifest.json` (unchanged from base)
- `src/core/map/generators/CaveGenerator.ts` (unchanged from base)

## Validation

- `npm run verify:fast` ✅ pass (232 tests)
- Headless floor-completion gate (`tests/headless/floor1-completion.test.ts`): seeds 6/2/5 × all weapons should clear — floor1 manifest kept at original 120×70 dimensions.

## Notes

- Cave shaping repaints passable room-interior floor tiles as CAVE_FLOOR and adjacent stone walls as CAVE_WALL; no new passability is carved.
- `pruneInaccessibleDoors` is guarded by `if (this.caveRegions)` so non-cave dungeon layouts are unaffected.
