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

## Files changed

- `/home/runner/work/Crawler/Crawler/src/core/map/generators/DungeonGenerator.ts`
- `/home/runner/work/Crawler/Crawler/src/core/map/generators/registry.ts`
- `/home/runner/work/Crawler/Crawler/tests/ecs/map-generators.test.ts`

## Validation

- `npm run verify:fast` ✅ pass
- `npm run verify` ❌ fails in existing headless floor-completion gates (`tests/headless/floor1-completion.test.ts`) with timeout/quest-completion assertions.
- `parallel_validation` run: CodeQL ✅ no alerts; code-review feedback addressed for SeededRandom usage and cave RNG documentation.

## Notes

- Cave shaping currently repaints passable room floor regions as cave floor and surrounding stone walls as cave walls (no new passability carved).
- Full verify failures are concentrated in headless floor 1 completion tests and are reproducible in this branch.
