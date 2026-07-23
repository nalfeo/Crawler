# Handoff — 2026-06-21 — slime leap split

## Apples

- Estimated: 🍎🍎🍎 (Medium)
- Actual: 🍎🍎🍎 (Medium)
- Delta: 0
- Verdict: 🎯 Exact

## Scope

Implemented new slime combat cadence (pause + wiggle + leap) and slime death splitting into mini slimes.

## Changes

- Added `AI_TYPE.LEAPER` and leaper behavior in `src/game/enemyAISystem.ts`:
  - prep phase with wiggle movement
  - leap phase with burst speed
  - leap-aware speed cap handling during separation
- Updated Floor 1 ambient spawning in `src/game/floor1Scenario.ts` so slime archetypes use `AI_TYPE.LEAPER`.
- Extended `src/core/systems/dropSystem.ts` with slime split-on-death logic:
  - 50% split chance for archetype `slime`
  - spawns two mini slimes
  - mini slimes get half HP and half contact damage
  - mini sprites are scaled down and tracked as `slime-mini`
- Added/updated tests:
  - `tests/game/enemy-ai.test.ts` leaper pause/wiggle/leap behavior coverage
  - `tests/ecs/drop-system.test.ts` split mechanics and halved stats coverage

## Validation

- `npm run verify:fast`
- `npm run verify`
- `parallel_validation`:
  - Code Review: only non-actionable note remained (core-layer cannot import `AI_TYPE` from game layer)
  - CodeQL: timed out per tool output; no rerun performed per instruction
