# ADR 0009 — Floor 1 Boss/Stair Room Architecture

**Status**: Accepted  
**Date**: 2026-06-09

## Context

Floor 1 needed two interrelated features:

1. **Stair countdown + boss spawn** — after objectives are met, a 30s countdown triggers, then stairs spawn alongside a "Large Slime Rat" boss; stairs remain locked until the boss dies.
2. **Boss/stair room tagging** — the dungeon generator should designate specific rooms as `BOSS_STAIR` and `SAFE` so that gameplay logic places the boss, stairs, and objectives in structurally meaningful locations rather than relying on ad-hoc distance scoring inside the scenario layer.

This change touches three architectural layers: `src/core/` (map/RoomGraph/FloorMap/DungeonGenerator), `src/game/` (floor1Scenario), and `src/engine/` (MainGameScene HUD + terrain colors), hence an ADR is required.

## Decision

### Room role model (`src/core/`)

- Introduce a `RoomRole` enum (`SPAWN`, `BOSS_STAIR`, `SAFE`, `NORMAL`) in `src/shared/map-types.ts` alongside `RoomData.role`.
- `RoomGraph` exposes `setRole()`, `getFirstRoomByRole()`, `getRoomsByRole()`.
- `DungeonGenerator` runs a post-generation distance-scoring pass to assign roles. The furthest room from the spawn becomes `BOSS_STAIR`; the second-furthest becomes `SAFE`. Interior floor tiles of those rooms are repainted with role-specific `TerrainType` values.
- `FloorMap` exposes `bossStairRoom`, `safeRoom`, `spawnRoom` getters as the stable public API consumed by game and engine layers.

### Stair countdown + boss spawn (`src/game/`)

- `floor1ObjectiveSystem` manages the countdown state machine: `waiting → countdown → spawned+locked → unlocked`.
- Boss death is detected via `entityExists(world.ecs, bossEid)` — simple, no extra components.
- `chooseObjectiveTiles()` uses `floorMap.bossStairRoom` / `floorMap.safeRoom` when available, falling back to distance scoring for biomes without discrete rooms (caves, arenas).

### Visual differentiation (`src/engine/`)

- `BOSS_STAIR_FLOOR` renders as dark crimson (`0x2d0e1e`); `SAFE_ROOM_FLOOR` as dark teal (`0x0f2340`).
- Stair marker in the HUD turns amber while locked and green when unlocked.

## Consequences

**Positive:**

- Room roles are a stable, reusable primitive — future floors, merchants, healing shrines, and any "special room" feature can reuse `RoomRole` and `FloorMap` getters without touching the generator.
- `floor1Scenario` no longer contains distance-scoring logic for its own sake; it delegates to the map layer.
- Visual distinction between boss room (dangerous) and safe room (refuge) improves moment-to-moment map readability.

**Negative/Risks:**

- Role assignment is deterministic from seed but depends on rot-js room order, which could produce unfavorable layouts (e.g., boss room too close to spawn). Mitigated by seed-based testing.
- Only `DungeonGenerator` implements role tagging; `CaveGenerator` and `ArenaGenerator` return `NORMAL` for all rooms (they produce no discrete rooms anyway). If those biomes ever need special rooms, they will need their own post-pass.
- The `RoomData.role` field is mutable (intentionally); callers must not rely on it being stable after generator construction.

## Alternatives Considered

- **Hardcode special tile positions in floor config**: rejected — too brittle, breaks on every map regen.
- **Tag rooms during rot-js callback**: not possible — rot-js doesn't expose room metadata during the tile callback; rooms are only available via `getRooms()` after `create()`.
- **Store boss EID as a component instead of on the objective state**: considered, but `Floor1ObjectiveState` already owns boss lifecycle state; a component would require an extra query per frame for a single entity.
