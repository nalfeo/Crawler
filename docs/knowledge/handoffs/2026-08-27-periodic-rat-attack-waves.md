# Session Handoff: Periodic Rat Attack Waves

## Date

2026-08-27

## Persona

Implementer

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
Source typecheck, focused tests, formatting, and the sim-side orphaned-system
wiring check passed. The repass adds an ECS ownership tag safe against recycled
entity IDs, a Floor 1 behavior gate, deterministic fallback placement so valid
waves reach their full pack size, and tests for cache reuse/invalidation and
non-Floor-1 inertness. The prior implementation's real pipeline harness
observed a 10-rat wave spawning through
`createFloorMainSceneOptions('floor1')`; this repass preserves that wiring.

## What's Next / Blockers

`npm run verify:fast` passes, including the focused attack-wave tests and the
repository's type, lint, data-contract, integrity, and coverage checks.
