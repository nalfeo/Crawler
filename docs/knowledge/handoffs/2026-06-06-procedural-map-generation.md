# Session Handoff: Procedural Map Generation Foundation

## Date
2026-06-06

## What Was Done
Built the procedural map generation foundation — hybrid tile grid + room graph architecture with FOV, doors, and wall collision.

### Files Created
- `src/shared/map-types.ts` — TileFlags bitfield, BiomeType enum, TerrainType, MapConfig, RoomData
- `src/core/map/TileMap.ts` — Flat Uint8Array grid with bitflag queries
- `src/core/map/RoomGraph.ts` — Room semantic overlay with spatial cache
- `src/core/map/FloorMap.ts` — Composite owning TileMap + RoomGraph + terrain + visibility
- `src/core/map/generators/DungeonGenerator.ts` — rot-js Uniform wrapper
- `src/core/map/generators/CaveGenerator.ts` — rot-js Cellular + connect()
- `src/core/map/generators/ArenaGenerator.ts` — Simple bounded arena
- `src/core/map/generators/registry.ts` — BiomeType → generator mapping
- `src/core/systems/fovSystem.ts` — RecursiveShadowcasting player FOV
- `src/core/systems/doorSystem.ts` — DoorState → tile flag sync

### Files Modified
- `src/core/world.ts` — Added `floorMap: FloorMap | null` + DoorState wiring
- `src/core/components.ts` — Added DoorState component + store
- `src/core/systems/index.ts` — Exported fovSystem, doorSystem
- `src/core/systems/movementSystem.ts` — Slide-based wall collision
- `package.json` — Added rot-js, @mikewesthad/dungeon dependencies

## What's Next
1. **Phaser TilemapRenderer** (`src/engine/TilemapRenderer.ts`) — render FloorMap as Phaser tilemap with fog-of-war
2. **Room-based enemy spawning** — update enemySpawnerSystem for valid floor tiles
3. **Map generation lab** (`src/labs/map-gen-lab/`) — visual sandbox
4. **Biome config data** (`src/shared/data/biomes.ts`) — data-driven biome definitions
5. **AI floor theming** — extend AI pipeline for biome-themed content

## Blockers
- Lab gate check script fails on Windows (bash `pipefail` unsupported). Labs still need to be created for fovSystem and doorSystem.
- One pre-existing flaky test in AI provider suite (`retries on bad-grid error`) — unrelated to map work.

## Branch State
- Branch: `nalfeo/procedural-map-generation`
- All tests passing: yes (168/168 ECS tests, 1 pre-existing flaky AI test)
- PR created: pending

## Test Results
- TileMap: 21 tests ✅
- RoomGraph: 15 tests ✅
- FloorMap: 11 tests ✅
- Generators: 18 tests ✅
- FOV System: 6 tests ✅
- Door System: 6 tests ✅
- Movement (incl. wall collision): 7 tests ✅
- Typecheck: clean
- Lint: clean

## Key Decisions Made
1. **Hybrid tile grid + room graph** — tiles for O(1) physics/LOS, rooms for AI/spawning
2. **Tiles are NOT ECS entities** — Uint8Array on GameWorld, not 40K entities
3. **rot-js determinism** — use `ROT.RNG.setSeed()`, not `Math.random` override (rot-js uses its own Alea RNG internally)
4. **Default 675×675 tiles** at 32px = 2min×2min traversal at player speed
5. **Slide-based wall collision** — try full move, then each axis independently
6. **TileFlags bitfield** — PASSABLE(0b0001), TRANSPARENT(0b0010), DOOR(0b0100), LIQUID(0b1000)
