# Session Handoff: Generation Pipelines (Mob, Tile, Decoration)

**Date**: 2025-01-08  
**Branch**: `nalfeo/generation-pipelines`  
**Status**: ✅ Complete and verified

## Summary

Extended the sprite generation pipeline architecture (ADR 0003) from weapons to three new domains: **mobs**, **tiles**, and **decorations**. All three pipelines are production-ready with full TypeScript definitions, JSON data, and comprehensive test coverage (28 tests, all passing).

## Work Completed

### Files Created

**Definition Files** (`src/shared/`)
- `mobDefs.ts` — 8 mob definitions with MobDef interface, MOB_DEFS ReadonlyMap, getMobDef() getter
- `tileDefs.ts` — 16 tile definitions with TileDef interface, TILE_DEFS ReadonlyMap, getTileDef() and getTilesByBiome() getters
- `decorationDefs.ts` — 18 decoration definitions with DecorationDef interface, DECORATION_DEFS ReadonlyMap, getDecorationDef() and getDecorationsByBiome() getters

**Data Files** (`src/shared/data/`)
- `mobs.json` — Serialized mob data (8 entries, 2998 bytes)
- `tiles.json` — Serialized tile data (16 entries, 4167 bytes)
- `decorations.json` — Serialized decoration data (18 entries, 5433 bytes)

**Test Lab** (`tests/unit/labs/`)
- `generationLab.test.ts` — Unified lab with 3 describe blocks (28 tests total):
  - Mob Pipeline: 8 tests (loading, lookup, rarity scaling, AI validation, stats, loot refs, sprites)
  - Tile Pipeline: 10 tests (loading, lookup, biome filtering, collision types, passability, hazard damage, sprite refs)
  - Decoration Pipeline: 10 tests (loading, lookup, biome filtering, depth layers, scale/rotation, animation, density, destructibility, spawn calculations)

### Key Design Decisions

1. **Unified Lab**: User requested a single generation lab instead of three separate labs. Implemented as single test file with three describe blocks.

2. **Density Calculations**: Decorations use density per 1000 floor pixels for spawn count calculations (e.g., torch 0.08 → ~46 spawns per 320×180 room).

3. **Collision Mapping**: 
   - Solid → Blocked (impassable)
   - Hazard → Deadly (damages player)
   - None → Walkable (passable)

4. **Hazard Damage Scaling by Biome**:
   - Organic: blood pool 5 dps
   - Tech: energy barrier 10 dps
   - Void: rift 20 dps

5. **Rarity Tiers** (mob definitions):
   - Common: zombie, skeleton, goblin (base stats)
   - Rare: reaver, wraith (1.5x stats)
   - Elite: goliath, mage-lord (2.5x stats)
   - Legendary: directors-proxy (5x stats + boss size)

### Testing & Validation

- ✅ All 28 generation lab tests pass
- ✅ Full verify:fast passes (941 tests total)
- ✅ Type checking passes
- ✅ Linting passes
- ✅ All sprite IDs validated (mob-*, tile-*, deco-* prefixes)
- ✅ Biome distribution validated (4 biomes each for tiles and decorations)
- ✅ Stat ranges validated (HP, speed, damage, knockback, gore, XP multipliers)
- ✅ Collider and passability types validated

## Next Steps

### Phase 2: Game System Integration
- Create `mobSpawner` system that reads from MOB_DEFS
- Create `tileSystem` that reads from TILE_DEFS for floor generation
- Create `decorationSystem` that reads from DECORATION_DEFS for scene dressing
- Create corresponding labs for each system (if not already present)

### Phase 3: Extensibility
- Implement sensor validation for mob sprites (silhouette, palette)
- Implement sensor validation for tile sprites (collision visual consistency)
- Implement sensor validation for decoration sprites (depth layer consistency)
- Add mob ability registry integration (currently referenced but not implemented)
- Add loot table integration for mob drops

### Considerations

1. **Sprite Catalog**: All sprite IDs (mob-*, tile-*, deco-*) must exist in the sprite catalog before deployment. Current definitions are ready but sprites are not validated at this stage.

2. **Loot Tables**: Mob definitions reference loot tables (e.g., "common-drops", "pillar-rubble") that should be implemented in `lootDefs.ts` or similar.

3. **Audio Cues**: Tile definitions reference audio cues (e.g., "step-stone") that should map to actual audio assets.

4. **Ability Slots**: Mob definitions have `abilitySlots` field but no ability registry integration yet. Phase 2 can add this.

5. **Destructibility**: Decorations can be marked destructible with optional loot tables. Floor generation system should spawn destructible variants during decoration placement.

## Technical Details

### Pattern (ADR 0003)
Each pipeline follows the same architecture:
1. **TypeScript Defs** — Interface definition + factory function + ReadonlyMap + getter functions
2. **JSON Data** — Serialized definitions for runtime loading
3. **Validation** — Type-safe access via getter functions with optional chaining support
4. **Lab Testing** — Comprehensive test coverage of loading, filtering, and business logic

### Sprite Prefixes (Required)
- Mob sprites: `mob-*` (e.g., `mob-zombie`, `mob-directors-proxy`)
- Tile sprites: `tile-*` (e.g., `tile-stone-floor`, `tile-blood-pool`)
- Decoration sprites: `deco-*` (e.g., `deco-torch`, `deco-rubble`)

### Biome Distribution
- **Dungeon**: stone, walls, grates, torches, pillars, barrels
- **Organic**: flesh, bone, blood pools, vines, fungal growths
- **Tech**: metal, circuits, energy barriers, panels, conduits
- **Void**: corrupted void, rifts, stars, tendrils, echoes

## Files Changed in This Session

```
Created:
  src/shared/mobDefs.ts
  src/shared/tileDefs.ts
  src/shared/decorationDefs.ts
  src/shared/data/mobs.json
  src/shared/data/tiles.json
  src/shared/data/decorations.json
  tests/unit/labs/generationLab.test.ts

Committed: feat(generation-pipelines): add mob, tile, decoration definitions and unified lab
  Hash: a3d9965
```

## Session Notes

- Initially created 3 separate test files (mobTuning, tileTuning, decorationTuning)
- User corrected course: consolidated into single unified lab with 3 describe blocks
- Moved test file from `src/labs/` to `tests/unit/labs/` to be discovered by vitest
- Fixed import paths after move
- Removed unused `getMobsByRarity` import (function doesn't exist)
- Fixed spawn count test assertion (torch vs barrel instead of torch vs rubble)
- All 28 tests passing, full verify suite passing (941 tests)

## Commit Message

```
feat(generation-pipelines): add mob, tile, decoration definitions and unified lab

- Add mobDefs.ts with 8 mob definitions (zombie, skeleton, goblin, reaver, wraith, goliath, mage-lord, directors-proxy)
- Add tileDefs.ts with 16 tile definitions across 4 biomes (dungeon, organic, tech, void)
- Add decorationDefs.ts with 18 decoration definitions for scene dressing and ambient objects
- Add serialized JSON data files for all three pipelines
- Add unified generationLab.test.ts with 28 tests covering mob, tile, and decoration pipelines
- All pipelines follow ADR 0003 pattern: TypeScript defs + JSON data + getter functions
- Mob definitions include rarity tiers (common, rare, elite, legendary) with stat scaling
- Tile definitions include collision types (none/solid/hazard) with passability validation
- Decoration definitions include depth layers (back/mid/front) and density calculations

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```
