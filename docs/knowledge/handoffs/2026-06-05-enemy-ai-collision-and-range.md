# Handoff: Enemy AI Collision Separation & Ranged Pursuit

**Date:** 2026-06-05
**Branch:** `nalfeo/fix-enemy-ai-collision-and-range`

## Summary

Fixed two bugs in `enemyAISystem`:

1. **Collision overlap enforcement** — Added a post-process `applySeparation()` pass that enforces the 25% max overlap rule between all enemy entities. Uses pairwise distance checks with a 12px minimum center distance (for 16px sprites) and applies proportional repulsion forces.

2. **Ranged pursuit persistence** — Removed the aggro-based bail-out from `applyRangedBehavior`. Ranged enemies now always chase the player when beyond attack range, regardless of aggro distance.

## Files Touched

- `src/game/enemyAISystem.ts` — Added separation constants, `applySeparation()` function, refactored ranged behavior
- `tests/game/enemy-ai.test.ts` — Updated 2 tests to match corrected behavior

## Verification

- `npm run typecheck` ✅
- `npm test` — 580/580 passing ✅
- `npm run lint` ✅

## Unresolved / Future Work

- **Aggro + LOS checks**: When multi-room maps with doors are implemented, enemies will need line-of-sight raycasting before aggroing, deaggro hysteresis, and a state machine (idle → pursuing → attacking → returning). Not needed for current open-arena gameplay.
- **Performance**: The separation pass is O(n²) over enemies. Fine for current counts (~20 enemies) but will need spatial partitioning if enemy counts grow significantly.

## Recommended Next Steps

- Validate separation feel in the enemy-ai-lab with higher spawn counts
- Consider exposing `SEPARATION_FORCE` as a lil-gui control in the lab for tuning
