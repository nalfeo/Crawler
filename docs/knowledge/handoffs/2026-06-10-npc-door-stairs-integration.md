# Handoff: NPC / Boss Door / Staircase Integration (Floor 1)

**Date:** 2026-06-10  
**Branch:** `nalfeo/integrate-npc-door-stairs-floor1`  
**Base:** `nalfeo/fix-floor1-feedback`  
**Complexity:** 🍎🍎 (estimated 🍎🍎, actual 🍎🍎 — pure wiring, no new infrastructure)  
**Tests:** 1120/1120 ✅

---

## What Was Done

Three "last mile" wiring tasks against existing Floor 1 infrastructure.

### Task 1 — Tutorial Goon NPC

- `src/game/floor1Scenario.ts`: `spawnNpc(world, spawn.x + 48, spawn.y, 'tutorial-goon')` after
  `world.floor1` assignment; result stored in `world.floor1.guideNpcEid`.
- `src/labs/floor1-lab/index.ts`: `npcSystem` imported from `'../../core/index.js'` and added to
  `preSystems`; subsystem status table updated.
- `src/engine/scenes/MainGameScene.ts`:
  - `npcSystem` added to core import block and called in the fixed-step loop (after `fovSystem`).
  - `keyE` (`KeyCodes.E`) registered in `create()`.
  - `interactionHint` (screen-space, bottom-centre) and `npcDialogueText` (screen-space, above
    hint) created in `initializeUi()`.
  - `updateInteractions()` private method: reads `world.npcs` sidecar for nearest NPC with
    `nearbyPlayer === true`; shows `[E] Talk` hint; on E-JustDown cycles
    `instance.dialogueIndex` and updates `npcDialogueText`.

### Task 2 — Boss Room Door Lock

- `src/game/floor1Scenario.ts`:
  - `setGoalFlag(world, 'floor1-defeat-boss', false)` initialised on scenario start.
  - Iterates `floorMap.bossStairRoom?.doors` — for each `DoorLocation` creates a `DoorState`
    entity (`createEntity` + `addComponent` with `isLocked: 1`) and calls
    `setDoorLockConfig` with `{ type: 'goal', goalId: 'floor1-defeat-boss' }`.
  - `setGoalFlag(world, 'floor1-defeat-boss', true)` added in `floor1ObjectiveSystem` inside
    the `!bossAlive` block. `doorSystem` (already ticking) auto-unlocks the doors.

### Task 3 — Staircase Visual + Interaction Prompt

- `FLOOR_1_MARKER_RADIUS_PX` bumped from 24 → 64 (bigger visible marker, slightly larger
  auto-trigger range).
- `MainGameScene.updateObjectiveMarkers()`: added `stairsLabel` (world-space `▼ STAIRS` text,
  depth 25, colour changes amber/green with lock state).
- `updateInteractions()`: shows `[E] Descend` hint when player is within `markerRadiusPx` of an
  unlocked, undiscovered staircase.
- `src/engine/sprites/tile-visuals.ts`: documented that `BOSS_STAIR_FLOOR` intentionally has no
  sprite entry and falls back to `TERRAIN_FALLBACK_COLORS` (deep crimson `0x3d0a18`).

---

## Files Changed

| File                                 | Change                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/game/floor1Scenario.ts`         | NPC spawn, door lock entities, goal flag wiring, marker radius                                   |
| `src/labs/floor1-lab/index.ts`       | npcSystem in preSystems + status table                                                           |
| `src/engine/scenes/MainGameScene.ts` | npcSystem import+call, keyE, stairsLabel, interactionHint, npcDialogueText, updateInteractions() |
| `src/engine/sprites/tile-visuals.ts` | Documented BOSS_STAIR_FLOOR fallback intent                                                      |

---

## Apple Metrics

| Dimension        | Estimate         | Actual           |
| ---------------- | ---------------- | ---------------- |
| Files touched    | 4                | 4                |
| Net new logic    | Minimal (wiring) | Minimal (wiring) |
| Complexity score | 🍎🍎             | 🍎🍎             |
| Verdict          | Calibrated ✅    | —                |

---

## Known Follow-Up Items

- NPC dialogue is stateless across sessions (not persisted). Fine for now.
- `[E] Descend` hint fires at same radius as the auto-trigger — player may see it only briefly.
  A two-tier radius (hint at 2× markerRadiusPx, trigger at 1×) would give more breathing room.
- `BOSS_STAIR_FLOOR` sprite frame not yet mapped in `tile-visuals.ts`. TODO comment left for
  the tile-explorer-lab pass.
- `npcSystem` is now called twice if a floor1-lab preSystems hook also includes it (deduplication
  harmless since it's idempotent — just a bitmask write on each NpcInstance).
