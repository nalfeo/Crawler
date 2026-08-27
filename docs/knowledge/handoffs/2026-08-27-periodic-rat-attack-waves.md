# Session Handoff: Periodic Rat Attack Waves

## Date

2026-08-27

## Persona

Producer

## Systems touched

enemies, mapgen

## Apples

3🍎 estimated, 3🍎 actual

## What Was Done

Repassed Issue #3639's periodic rat attack-wave implementation. The feature
remains default-off and wired in the real Floor 1 post-system pipeline. The
safe-room suppression cache now uses a true multi-source BFS seeded by the
authoritative `interiorCells` (with bounds fallback), invalidates when cleared
room membership changes, and ignores cleared IDs belonging to another floor
map. Spawn positions stay at the configured off-screen radius, which is now
50 ft to cover the authoritative 1280x720 Floor 1 viewport diagonal.

Focused attack-wave tests now run spawned rats through the real
`enemyAISystem` -> `movementSystem` pipeline and assert distance decreases.
Source typecheck, fast verification, and the sim-side orphaned-system wiring
check passed. The prior implementation's real pipeline harness observed a
10-rat wave spawning through `createFloorMainSceneOptions('floor1')`; this
repass preserves that wiring.

## What's Next / Blockers

No blockers.
