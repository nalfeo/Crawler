# Session Handoff: NPC System — Guild Guide + Invincibility

## Date

2026-06-10

## Apples

- Estimated: 🍎🍎🍎🍎 (Large)
- Actual: 🍎🍎🍎🍎 (Large)
- Delta: 0 — 🎯 Exact
- Note: New ECS system + component tags + lab + tests + floor1 integration exactly matched the Large profile.
- hello_kitties: 0.80

## Summary

Implemented the NPC system foundation for Crawler. NPCs are non-hostile, invincible by default, and carry dialogue + quest data. The first NPC — the Starter Guild Game Guide — spawns at the personal space (room nearest player spawn) on Floor 1 and offers the "Defeat the Boss" quest.

## Files Touched

- `src/shared/npc-types.ts` _(new)_ — `NpcDef`, `NpcQuestDef`, `NpcInstance`, `QuestStatus`, `NPC_INTERACT_RANGE_PX`, `guild-guide` def
- `src/core/components.ts` — Added `Npc`, `Invincible` tags + `npc` store
- `src/core/world.ts` — Added `npcs: Map<number, NpcInstance>`, wired Npc store observer, imported `NpcInstance`
- `src/core/apply-damage.ts` — Guard: returns 0 for `Invincible` entities before any health mutation
- `src/core/helpers.ts` — Added `spawnNpc(world, x, y, defId)` helper
- `src/core/systems/npcSystem.ts` _(new)_ — Proximity detection system
- `src/core/systems/index.ts` — Exported `npcSystem`
- `src/shared/floor1.ts` — Added `personalSpacePos` to `Floor1ObjectiveState`, `guideNpcEid` to `Floor1ScenarioState`
- `src/game/floor1Scenario.ts` — `chooseObjectiveTiles` now returns `personalSpacePos`; spawns Guild Guide NPC on init
- `src/labs/npc-lab/index.ts` _(new)_ — Canvas-based NPC lab with WASD movement and dialogue trigger
- `src/lab-main.ts` — Registered `npc-lab`
- `src/labs/hud-lab/index.ts` — Added missing `personalSpacePos` + `guideNpcEid` to inline state
- `tests/ecs/npc.test.ts` _(new)_ — 12 unit tests (spawn, invincibility, proximity, edge cases)

## What Was Done

### NPC Component Tags

- `Npc` — marks an entity as an NPC (queried by `npcSystem`)
- `Invincible` — tag that short-circuits `applyDamage` entirely (no HP change, no combat event)

### `spawnNpc` Helper

Creates an NPC entity with Position + Sprite + Npc + Invincible components, and registers an `NpcInstance` sidecar in `world.npcs`. Returns -1 for unknown def IDs.

### `npcSystem`

Pure `(world: GameWorld) => void` system. Queries all `[Npc, Position]` entities and updates `instance.nearbyPlayer` based on player distance. Clears flags when no player exists.

### Guild Guide Definition

- 3 dialogue lines cycling via `dialogueIndex`
- 1 quest: `floor1-defeat-boss` ("Defeat the Boss")
- Initial quest status: `'available'`

### Floor 1 Integration

`chooseObjectiveTiles` now selects 3 room positions: farthest (safe room), second-farthest (staircase), and nearest to spawn (personal space). The Guild Guide spawns at the personal space pixel position.

### NPC Lab

Standalone canvas lab (`?lab=npc-lab`). Player moves with WASD/arrows. Approaching the NPC within 80px shows the dialogue box and a `[E] Talk` prompt. Pressing E/Enter advances dialogue. lil-gui provides Teleport and Advance Dialogue buttons.

## Verification Run

- `npm run verify:fast` — 104 test files, 1035 tests, all passed
- CodeQL scan: 0 alerts
- Code review: no comments

## Unresolved Issues

- NPC interaction (accepting a quest, marking it active) is not yet wired — the `dialogueIndex` advances but quest status stays `'available'`. A follow-up system can set `status: 'active'` on player confirmation.
- No visual indicator in the main game scene for NPC proximity or dialogue; rendering layer hookup is a follow-up task.
- The "defeat the boss" quest has no boss entity to resolve against yet.

## Recommended Next Steps

1. Wire `npcSystem` into `MainGameScene` pre/post hooks so it runs in-game.
2. Add an interaction action (key press) in the game scene that advances `dialogueIndex` and sets quest `status: 'active'`.
3. Render an NPC dialogue HUD overlay in the engine layer (proximity indicator + dialogue box).
4. Implement a boss entity and resolve the `floor1-defeat-boss` quest on kill.

## Branch State

- Branch: current working branch
- All tests passing: yes (fast verify)
- PR created: yes
