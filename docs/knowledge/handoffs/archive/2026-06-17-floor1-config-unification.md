# Handoff: Floor 1 Config Unification — 2026-06-17

## Apple Estimate

- Declared: 🍎🍎🍎🍎 (Large)
- Actual: 🍎🍎🍎🍎
- Verdict: **🎯 Exact**

This was Phase 1 of a multi-phase architectural refactoring to make Floor 1 config-driven instead of hardcoded. The task involved creating a Zod schema, updating JSON config, and refactoring ~60 constants across a large scenario file.

## Summary

Replaced hardcoded Floor 1 constants with a config-driven system that loads and validates `floor1.json` at module initialization. This is the foundational step toward supporting procedural, randomized floors in the roguelite.

## What Changed

### New Files

- `src/shared/floor1-config.ts` — Zod schema and loader for Floor 1 configuration
- `tests/unit/floor1-config.test.ts` — 10 tests validating config loading

### Modified Files

- `src/shared/data/floor1.json` — Added missing fields:
  - `starterWeapons: ["sword", "knife", "bow", "pistol", "throwing-knife"]`
  - `bossVariants` section with `slimeRat` and `ratSlime` configurations
  - `sprites.welcomeSign: 3`
- `src/game/floor1Scenario.ts` — Refactored to use `floor1Config` instead of ~60 constants:
  - Replaced `FLOOR_1_PROTAGONIST`, `FLOOR_1_STARTER_POOL`, `FLOOR_1_TIMER_MS`, etc.
  - Replaced `RAT_HP`, `RAT_SPEED`, `SLIME_HP`, `SLIME_SPEED`, etc.
  - Replaced `FLOOR_1_SLIME_RAT_HP`, `FLOOR_1_RAT_SLIME_HP`, boss stats
  - Replaced `FLOOR_1_ENEMY_CAP`, `FLOOR_1_SPAWN_INTERVAL_MS`, spawning config
  - Replaced `FLOOR_1_PLAYER_HP_BONUS`, stat bonuses
  - Map config now built from `floor1Config.map.*` instead of spread
  - Kept only derived constants: `FLOOR_1_CAMERA_ZOOM`, viewport calculations, `FLOOR_1_GOAL_PREFIX`

## Verification

- `npm run verify:fast` — ✅ All 59 tests pass
- `npm run verify` — ✅ 1253/1254 tests pass
  - 1 pre-existing failure: `tests/integration/synth-to-generate.test.ts` (unrelated sprites test requiring Azure OpenAI Vision)
- `npm test -- floor1` — ✅ All 16 floor1-specific tests pass
- `npm test -- floor1-config` — ✅ All 10 config validation tests pass

## Architecture

### Floor1Config Schema

```typescript
{
  protagonist: string,
  starterWeapons: string[],
  timer: { durationMs, stairSpawnCountdownMs },
  objectives: { requiredRats, requiredSlimes, requiredTotalKills, requiredGold, requiredJunk, markerRadiusPx },
  map: { widthTiles, heightTiles, tileSizePx, seed, roomWidthRange, roomHeightRange, maxRooms, floorDensity },
  enemies: {
    rat: { hp, speed, detectRange, spawnWeight, spriteTexture },
    slime: { hp, speed, detectRange, spriteTexture },
    boss: { hp, speed, detectRange, spawnRadiusMin, spawnRadiusMax, spriteWidth, spriteHeight, fireballCooldownMs }
  },
  bossVariants?: {
    slimeRat: { hp, speed, detectRange, fireballCooldownMs },
    ratSlime: { hp, speed, detectRange, fireballCooldownMs, spawnRadiusMin, spawnRadiusMax, spriteWidth, spriteHeight }
  },
  spawning: { enemyCap, spawnIntervalMs, spawnRadiusMin, ambientSpawnMaxDistancePx, ambientDespawnDistancePx },
  player: { hpBonus, moveSpeedBonus, pickupRangeBonus },
  camera: { zoom },
  sprites?: { welcomeSign }
}
```

### Usage Pattern

```typescript
// Old (hardcoded):
const FLOOR_1_REQUIRED_RATS = 6;
const RAT_HP = 20;

// New (config-driven):
floor1Config.objectives.requiredRats;
floor1Config.enemies.rat.hp;
```

The config is loaded and validated at module initialization, so any JSON errors fail fast at startup.

## Next Steps (Future Phases)

This completes **Phase 1: Config Unification** of the plan. Remaining phases:

### Phase 2: Enemy Pack Abstraction (2-3 🍎)

- Create `src/shared/enemy-packs.ts` with `EnemyPackDef` schema
- Extract Floor 1 director logic into a config-driven spawner
- Move enemy definitions into `data/enemies.floor1.json`
- Make `floor1EnemyDirectorSystem` read from enemy pack config

### Phase 3: Floor Manifest Schema (3-4 🍎)

- Define `FloorManifestDef` schema in `src/shared/floor-manifest.ts`
- Create `data/floors/floor1.manifest.json` aggregating config + enemy packs + NPC placements + objectives
- Write `initializeFloorFromManifest(world, manifestId)` to replace `initializeFloor1Scenario`

### Phase 4: NPC & Event Generalization (2-3 🍎)

- Create `NpcPlacementDef` schema
- Move Tutorial Goon, Shopkeeper, Spell Giver definitions to manifest
- Abstract NPC spawn logic into `spawnNpcFromDef(world, def, roomPos)`
- Make quest activation automatic based on manifest `giverNpcId`

### Phase 5: Floor Registry & Multi-Floor Support (2-3 🍎)

- Create `src/shared/floor-registry.ts` with manifest loader
- Update `MainGameScene` to accept `floorId` parameter
- Add floor progression logic (stair descend → load next floor)
- Test Floor 1 + stub Floor 2 manifest

## Key Design Decisions

1. **Zod for validation** — Catches config errors at module load, not at runtime
2. **Optional fields with `!` operator** — `bossVariants` and `sprites` are optional for future floor flexibility, but Floor 1 always has them
3. **Kept derived constants** — `FLOOR_1_VIEWPORT_WIDTH_PX` still computed from config because it's a derived value used in multiple places
4. **Preserved `FLOOR_1_GOAL_PREFIX`** — Goal flag naming convention is code-level, not config
5. **BiomeType stays hardcoded** — The `BiomeType.DUNGEON` value remains in code because it's an enum, not a config tunable (JSON has the map parameters but not the biome type string yet)

## Notes for Future Agents

- **floor1.json is now the source of truth** for all Floor 1 tuning values
- **To add a new floor config field:** Update the Zod schema in `floor1-config.ts`, add the field to `floor1.json`, and reference it via `floor1Config.*`
- **Pre-existing sprite test failure:** `tests/integration/synth-to-generate.test.ts` fails due to missing Azure OpenAI Vision config; unrelated to this work
- **Enemy director still hardcoded:** Phase 2 will make enemy spawning config-driven; for now, the director reads from `floor1Config.enemies.*` but the logic is still Floor 1-specific

## Hello Kitties

1 session delivered **0.80 hello kitties** (4 apples / 5).
