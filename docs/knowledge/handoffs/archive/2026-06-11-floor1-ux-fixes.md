# Handoff: Floor 1 Lab UX Fixes

**Date:** 2026-06-11  
**Session:** floor1-lab-launch  
**Branch:** nalfeo/floor1-lab-launch  
**Complexity estimate:** 🍎🍎 (actual: 🍎🍎)

## What Was Done

Four player-reported UX issues in the Floor 1 lab were fixed in a single commit (`c26db7f`).

### Bug 1 — Merchant room as safe room (minimap + enemy exclusion)

- Added `tagShopRoomAsSafe(world, shopRoomPos)` in `floor1Scenario.ts`, called immediately after `chooseObjectiveTiles`.
- It finds the shop room via `floorMap.roomGraph.getRoomAt(tile)`, tags it `RoomRole.SAFE` via `roomGraph.setRole`, and repaints floor tiles to `TerrainType.SAFE_ROOM_FLOOR` so the terrain renderer and minimap both show it correctly.
- `isPointInSafeSpace` in `src/core/safe-space.ts` now iterates ALL SAFE rooms via `getRoomsByRole(RoomRole.SAFE)` instead of just `floorMap.safeRoom` (the generator-tagged one).
- `isInvalidSpawn` in `floor1EnemyDirectorSystem` now checks all SAFE rooms via the same API.
- `viableRooms` filter in `resolveSpawnPosition` now uses `room.role !== RoomRole.SAFE` instead of identity comparison.

### Bug 2 — No rat tail hint

- Shopkeeper dialogue line 2 updated to say the tail is found "in the deeper, far-flung rooms of this dungeon."
- Quest objective label for `fetch-prize` updated to `'Retrieve his "special" rat tail (dropped in a far dungeon room)'`.
- Files: `src/shared/npc-types.ts`, `src/shared/quest-types.ts`.

### Bug 3 — Speak/dialog text overlap

- `npcDialogueText` moved from `GAME.HEIGHT - 72` to `GAME.HEIGHT - 120` (48px higher).
- `dialogueCloseButton` moved from `GAME.HEIGHT - 104` to `GAME.HEIGHT - 152`.
- `interactionHint` is now **hidden** while a conversation is active (was erroneously showing "Next" alongside the dialogue box).
- File: `src/engine/scenes/MainGameScene.ts`.

### Bug 4 — Goon quest starts before meeting the goon

- Removed `acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID)` from `initializeFloor1Scenario`.
- Exported `meetTutorialGoon(world)` from `floor1Scenario.ts` — accepts the quest, notifies the talk objective, and sets `objective.questAccepted = true`.
- Added `tutorialGoon?: { meet: (world: GameWorld) => void }` to `MainGameSceneOptions`.
- `updateInteractions()` calls `this.options.tutorialGoon?.meet(this.world)` when the player first talks to the `tutorial-goon` NPC.
- `meetTutorialGoon` exported via `src/game/index.ts` and wired in `src/labs/floor1-lab/index.ts`.

## State of the Branch

- All changes committed, `verify:fast` green (114 files, 1144 tests).
- Lab still running at `http://localhost:3002/lab.html?lab=floor1-lab`.
- PR not yet opened — can be opened from this branch or squashed to main.

## Known Remaining Issues / Next Steps

- The merchant room terrain repaint only affects `STONE_FLOOR` tiles; any corridors connecting to it keep their corridor type — this is cosmetically fine.
- No visual "safe zone" indicator (aura, icon) in the main view — low priority but would improve discoverability.
- Boss room safe-space behaviour (not spawning enemies in boss room during active fight) was not changed; that system uses `floorMap.bossStairRoom` identity and is separate.
