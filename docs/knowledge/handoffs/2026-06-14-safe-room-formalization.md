# Handoff: Safe Room System Formalization — 2026-06-14

## Session Summary

Formalized the safe room system as described in the problem statement:
safe rooms have no combat, timers pause inside them, and customization systems
(equipment, inventory) are only accessible from within them (subject to
feature-unlock gates).

## Apple Estimate

- Declared: 🍎🍎🍎🍎 (Large)
- Actual: 🍎🍎🍎🍎
- Verdict: **on-estimate** — multi-file coordination: core world, safe-space
  system, equipment gating, floor1 timer, MainGameScene loop + UI, lab, tests,
  ADR.

## What Shipped

### `world.playerInSafeRoom: boolean`

Added to `GameWorld` in `src/core/world.ts`. Defaults to `false`. This is the
canonical runtime flag for "player is in a safe room right now".

### `safeRoomSystem(world)` + `isInSafeContext(world)`

Added to `src/core/safe-space.ts`:

- **`safeRoomSystem`** — ECS system called each tick (after `movementSystem`,
  before `postSystems`). Queries for `Player`, calls `isEntityInSafeSpace`,
  writes result to `world.playerInSafeRoom`. No-ops outside `'playing'` state.
- **`isInSafeContext`** — returns `world.playerInSafeRoom ||
world.state === 'safe_room'`. Single gate for all customization access.
- Both are re-exported from `src/core/systems/index.ts`.

### Equipment gating update

`equip()` and `unequip()` in `src/core/systems/equipmentSystem.ts` now check
`isInSafeContext(world)` instead of `world.state === 'safe_room'` directly.
This allows equipping/unequipping whenever the player is physically in a safe
room (not just at end-of-run).

### Floor collapse timer pausing

`floor1ObjectiveSystem` in `src/game/floor1Scenario.ts` now advances
`objective.deadlineMs += GAME.DELTA_MS` each tick when `world.playerInSafeRoom`
is true — keeping effective remaining time constant while in a safe room.
`deadlineMs` changed from `readonly` to mutable in `Floor1ObjectiveState`
(`src/shared/floor1.ts`).

### MainGameScene wiring

- `safeRoomSystem` called between `fovSystem` and `npcSystem` in the
  fixed-timestep loop.
- `[I]` (inventory) and `[G]` (equip) keys now additionally require
  `isInSafeContext(world)`.
- Unlock toast messages updated to hint "in a safe room".

### Lab

`src/labs/safe-room-lab/index.ts` — DOM canvas lab with two rooms (safe/normal),
a movable player dot, lil-gui panel showing `playerInSafeRoom`,
`isInSafeContext`, and a "Try Equip" button that demonstrates the gate.
Registered as `safe-room-lab` in `src/lab-main.ts`.

### Tests

`tests/ecs/safe-room.test.ts` — 17 tests covering:

- `isPointInSafeSpace` (inside/outside/no-map/no-safe-rooms)
- `safeRoomSystem` (updates flag, no-op outside playing, player moves between zones)
- `isInSafeContext` (both cases + neither)
- Equipment gating (rejected outside, allowed in safe room, allowed in safe_room state)
- Property test: `safeRoomSystem` never throws for any pixel position

### ADR

`docs/knowledge/adr/0013-safe-room-runtime-system.md`

## Key Files

- `src/core/safe-space.ts`
- `src/core/world.ts`
- `src/core/systems/equipmentSystem.ts`
- `src/core/systems/index.ts`
- `src/shared/floor1.ts`
- `src/game/floor1Scenario.ts`
- `src/engine/scenes/MainGameScene.ts`
- `src/labs/safe-room-lab/index.ts`
- `src/lab-main.ts`
- `tests/ecs/safe-room.test.ts`
- `docs/knowledge/adr/0013-safe-room-runtime-system.md`

## Known Follow-ups

- **Skills/ability panel** — the problem statement mentions skill configuration
  as a customization system. Once the skill assignment UI is implemented it
  should check `isInSafeContext(world)` before opening.
- **Achievement/loot box UI** — same gate applies when those panels are built.
- **Other floor scenarios** — any new floor's timer system should follow the
  same `world.playerInSafeRoom` pause pattern used in `floor1ObjectiveSystem`.
- **`staircaseSpawnRemainingMs`** — declared in `Floor1ObjectiveState` but not
  yet actively used as a live countdown. When implemented it should also be
  paused via `world.playerInSafeRoom`.
