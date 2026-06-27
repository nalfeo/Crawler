# ADR-0012: Multi-Safe-Room Support and NPC Quest Callback Pattern

## Status

Accepted

**Date:** 2026-06-11  
**Deciders:** Agent session (floor1-lab-ux-fixes)

## Context

Two design pressures converged:

1. **Multiple safe rooms per floor.** Floor 1 needs both a "Welcome Office" (the generator-tagged SAFE room where the player spawns) and a **merchant room** (chosen at runtime as the nearest non-special room). The merchant room needed safe-room semantics: no enemy spawns, minimap icon, floor tile color. The original `isPointInSafeSpace` and enemy-spawner exclusion checked only `floorMap.safeRoom` (the first `RoomRole.SAFE` room), so a second safe room would have been ignored.

2. **NPC-gated quest acceptance.** The Tutorial Goon's pest-control quest was being pre-accepted at floor init, causing it to appear in the quest log before the player had met the NPC. The Shopkeeper's errand was already gated via a `shopkeeper.meet` callback injected through `MainGameSceneOptions`. The same pattern needed to be applied consistently.

## Decision

### Safe rooms

- **`tagShopRoomAsSafe(world, pos)`** in `floorScenario.ts`: after map generation, finds the shop room via `roomGraph.getRoomAt`, calls `roomGraph.setRole(id, RoomRole.SAFE)`, and repaints its floor tiles to `TerrainType.SAFE_ROOM_FLOOR` in the terrain array. This happens before `drawFloorTerrain()` bakes the RenderTexture.
- **`isPointInSafeSpace`** in `src/core/safe-space.ts` now iterates _all_ rooms tagged `RoomRole.SAFE` via `roomGraph.getRoomsByRole(RoomRole.SAFE)`. The function no longer has a hard dependency on the single `floorMap.safeRoom` getter.
- **Enemy spawner** (`floor1EnemyDirectorSystem`) and **spawn position resolver** (`resolveSpawnPosition`) updated to use role-based checks instead of object-identity comparisons against `floorMap.safeRoom`.

### NPC quest callbacks

- `MainGameSceneOptions` now has an optional `tutorialGoon?: { meet: (world) => void }` field, mirroring the existing `shopkeeper` field.
- `meetTutorialGoon(world)` in `floorScenario.ts` calls `acceptQuest`, `notifyQuestTalk`, and sets the legacy `questAccepted` flag — all in one place.
- `updateInteractions()` in `MainGameScene` calls `options.tutorialGoon?.meet()` on the player's first interaction with the `tutorial-goon` NPC. `objective.questAccepted = true` is no longer set for arbitrary NPC talk.

## Consequences

### Positive

- Any future floor can designate multiple safe rooms (e.g., a mid-floor rest point) without changes to core safe-space logic.
- Quest-acceptance timing is now explicitly controlled per NPC via injected callbacks; `MainGameScene` stays free of game-layer imports.
- Minimap and terrain renderer automatically reflect new safe rooms because they key off `RoomRole.SAFE`.

### Negative / Risks

- `tagShopRoomAsSafe` must be called _before_ `drawFloorTerrain()`; the ordering is implicit (both happen in `create()`). A future refactor that calls `configureWorld` lazily could break terrain painting silently — the room role would still be correct but the floor tiles would show the wrong color.
- Terrain painting only affects `STONE_FLOOR` tiles; corridor tiles connecting to the merchant room keep their corridor type. This is visually acceptable but not perfectly consistent.

## Alternatives Considered

1. **Hardcode the merchant room in the generator.** Would require the generator to know about game-layer concepts (merchants). Rejected — violates the `src/core` purity rule.
2. **Add a second `safeRoom2` field to `FloorMap`.** Simple but doesn't scale beyond two safe rooms. Rejected in favor of the role-based multi-room API already on `RoomGraph`.
3. **Accept tutorial quest in a `postSystems` hook.** Would fire every tick until talked to, requiring extra state. Rejected — the NPC callback pattern is already established for the shopkeeper.
