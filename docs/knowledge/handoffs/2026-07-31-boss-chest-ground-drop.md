# Session Handoff: Boss chest ground drop

## Date

2026-07-31

## Persona

Game Designer

## Systems touched

inventory, boss-rooms, hud-ux, devtools

## Apples

3🍎 estimated, 3🍎 actual (exact)

## What Was Done

Replaced the old side-panel boss chest flow with a physical in-world chest flow. Boss kills
now produce a real chest entity on the ground, the player opens it by walking into it, the
reward uses the shared reward-opening overlay, and save/load preserves the physical chest.

- Added `BossChestEntity`, `world.bossChestEids`, `'boss-chest'` physics sizing, and
  `spawnBossChestEntity(...)`.
- Added `bossChestPickupSystem` to auto-open available boss chests within a 4ft radius and
  wired it into the real core simulation step.
- Removed `src/engine/BossChestUI.ts` and all MainGameScene ownership of the old side panel.
- Reused the shared reward-opening overlay by teaching `MainGameScene` to resume pending boss
  chest presentations and to surface live reveals during active play.
- Updated boss chest creation and carryover so available physical chests persist `spawnX` /
  `spawnY` and respawn on restore.
- Added a fallback in `boss-chest-resolver.ts` so boss chests created without stored boss
  coordinates spawn at the live player position instead of becoming unreachable.
- Added a dedicated pickup lab plus probe/e2e updates so the real scene can seed and observe
  physical boss chests.

## Key Decisions Made

- **Use a physical ECS chest entity, not a special-case UI affordance.**
  That keeps boss chests aligned with other world pickups and matches the user-visible rule
  that the chest exists on the ground.
- **Keep reward presentation centralized.**
  Chest pickup only changes how a reward is triggered; the reveal / summary / acknowledge
  sequence still flows through the existing shared reward-opening overlay.
- **Persist physical spawn coordinates in carryover.**
  Save/load needs to restore a chest back into the world, not merely remember that one exists.
- **Fail safe when boss coordinates are missing.**
  Falling back to the current player position is better than creating an unreachable available
  chest with no in-world entity.

## Files Changed

- `src/core/components.ts`
- `src/core/physics-defs.ts`
- `src/core/simulation-core-step.ts`
- `src/core/spawners/world-objects.ts`
- `src/core/systems/bossChestPickupSystem.ts`
- `src/core/systems/index.ts`
- `src/core/world.ts`
- `src/engine/scenes/MainGameScene.ts`
- `src/game/boss-chest-resolver.ts`
- `src/game/floor2Scenario.ts`
- `src/game/playerCarryover.ts`
- `src/lab-main.ts`
- `src/labs/bosschestpickup-lab/index.ts`
- `src/labs/main-scene-probe-lab/index.ts`
- `src/labs/reward-opening-ux-lab/index.ts`
- `tests/e2e/helpers/main-scene-probe.ts`
- `tests/e2e/main-game-scene-ui-exclusivity.test.ts`
- `tests/e2e/reward-opening-ux.test.ts`
- `tests/unit/boss-chest-resolver.test.ts`
- `tests/unit/bossChestPickupSystem.test.ts`
- `tests/unit/main-game-scene-mobile-ui.test.ts`
- `tests/unit/player-carryover.test.ts`
- `docs/knowledge/game-design/entity-sizing.md`
- `docs/knowledge/metrics/guard-telemetry/2026-07-31-boss-chest-ground-drop.json`
- `docs/knowledge/review-ledgers/2026-07-31-boss-chest-ground-drop.review-ledger.json`
- `scripts/agent/health/check-physics-defs-sync.ts`

## Verification

- `npx vitest run tests/e2e/reward-opening-ux.test.ts -t "opens the reward overlay when the player walks into a live physical boss chest" tests/unit/boss-chest-resolver.test.ts tests/unit/player-carryover.test.ts tests/unit/bossChestPickupSystem.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate`
- `npm run verify:pr-prereqs`

## Unresolved Issues / Blockers

None. The branch is ready for PR creation once the working tree is committed.
