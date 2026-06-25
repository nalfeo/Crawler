# Session Handoff: Boss Wall Spawn Fix (Seed 665790)

## Date

2026-06-24

## Persona(s) adopted

Systems Engineer — pure ECS/game-logic spawn position fix in `src/game/`.

## Routing verdict

✅ right persona — single-function bug in game layer, no rendering or multi-system coordination.

## Apples

Estimated: 🍎🍎  
Actual: 🍎  
Verdict: ⬆️ Under (estimated 2, needed 1)

Hello kitties: 1/5 = 0.20 🎀

## What Was Done

Fixed a deterministic bug where seed 665790 caused the final boss (Rat Slime) to spawn inside a wall tile.

### Root Cause

`resolveBossSpawnPosition` in `src/game/floor1Scenario.ts` had a two-tier search:

1. 24 random attempts within center±2 of the boss room bounds
2. Exact center tile check

For seed 665790, variety post-processing left only **one** passable interior tile at (116, 56) in the boss room — outside the center±2 window. Both tiers failed and the function fell through to a radius-based fallback anchored to `stairX/stairY`, which placed the boss in a wall.

The boss room grid looked like:

```
 55: ###########
 56: #########.#   ← only passable tile, top-right area
 57: ###########
...
 59: #####C#####   ← center is a wall
...
 62: ###########
```

### Fix (src/game/floor1Scenario.ts)

Added a third-tier fallback in `resolveBossSpawnPosition`: a full interior scan of the boss room (all tiles one step inside the perimeter, early-exit on first passable) between the center search and the radius-based approach.

### Test (tests/game/floor1-scenario.test.ts)

- Added `startFloor1BossEncounter` to the imports
- Added regression test `regression: seed 665790 spawns final boss at a passable tile (not in a wall)` that initializes with seed 665790, triggers the boss encounter, and asserts the boss's position tile is passable

## What's Next

- Optional: the same pattern of "room mostly walled" could affect the slime-rat boss room for other seeds — `resolveBossSpawnPosition` now covers both since it's shared. No further action needed.
- The player's entry point in `startFloor1BossEncounter` (used by the skip shortcut) is still `floorMap.tileToPixel(center.x, center.y)` — this can be a wall for pathological seeds. Not game-breaking (it's a skip shortcut teleport) but worth noting.

## Blockers

None.

## Branch State

- Branch: working branch
- All tests passing: yes (113 unit tests)
- PR created: yes (#276)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no telemetry section.
