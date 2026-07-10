# Handoff: Hallway Smoothing Passages

**Date:** 2026-07-10  
**Session:** hallway-smoothing-passages  
**Estimated apples:** 🍎🍎🍎  
**Actual apples:** 🍎🍎🍎  
**Verdict:** exact

## Systems touched

mapgen, devtools, ci-policy

## What was done

- Preserved the hallway smoothing feature as a **render-only** terrain overlay in:
  - `src/engine/terrain/passage-smoothing.ts`
  - `src/engine/terrain-renderer.ts`
  - `src/labs/hallway-smoothing-lab/index.ts`
- Reverted the gameplay-affecting corridor-generation drift in `src/core/map/generators/dungeon/corridors.ts`, along with the drifted generator/navmesh goldens, after CI showed the branch had changed headless collision-pair fingerprints.
- Merged `origin/main` into the branch cleanly after the fix commit.
- Tightened the renderer seam so smoothing is **opt-in at the API** and **explicitly enabled** by the real game in `src/engine/scenes/MainGameScene.ts`.
- Removed the ignored `subFactor` parameter from `measurePassageJaggedness(...)` so the public API matches behavior.
- Added/updated regression coverage:
  - hallway smoothing lab wiring
  - passage smoothing helper behavior
  - renderer immutability when smoothing is enabled
  - explicit MainGameScene opt-in for smooth hallway rendering

## Why

The original branch mixed two concerns: a visual hallway-smoothing overlay and a real dungeon-generation change. The visual overlay was fine, but the corridor-generation rewrite changed live map geometry enough to trip the headless collision-pair parity gate. The final branch keeps the intended hallway visual smoothing while restoring gameplay determinism.

## Validation

- `npx vitest run tests/unit/passage-smoothing.test.ts tests/unit/terrain-renderer.test.ts tests/unit/hallway-smoothing-lab-wiring.test.ts tests/ecs/map-generators.test.ts tests/determinism/navmesh-determinism.test.ts tests/headless/collision-pair-parity.test.ts`
- `npx vitest run tests/unit/terrain-renderer.test.ts tests/determinism/dungeon-generator-golden.test.ts tests/headless/collision-pair-parity.test.ts`
- `npx vitest run tests/unit/passage-smoothing.test.ts tests/unit/terrain-renderer.test.ts tests/unit/main-game-scene-lighting-overlay.test.ts tests/ecs/map-generators.test.ts`
- `npm run verify:fast`
- `npm run verify`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-10-hallway-smoothing-passages.review-ledger.json`

## Review harness

- Plan review: `gpt-5.4` → approved with minor changes
- Code review: `claude-sonnet-4.6`
  - Round 1: 2 concerns found and fixed
  - Round 2: clean

## Unresolved issues / next steps

- Branch code/tests/ledger/handoff are green locally, but the PR still has a **metadata** blocker: `commit-lint` fails because the PR title `Creating a system for smooth transitions in hallways` is not a conventional-commit title. Rename it to something like `feat: smooth hallway visual transitions`.
- The PR is still showing as draft in GitHub metadata; if the automation does not flip it, mark it ready for review to match repo/user policy.
