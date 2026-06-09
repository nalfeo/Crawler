# Session Handoff: Floor 1 tutorial vertical slice

## Date

2026-06-08

## Summary

- Added an initial **Floor 1 scenario pipeline** that boots the player into a loadout phase, offers 3 deterministic starter weapon choices from a basic pool, and transitions into gameplay after selection.
- Implemented a **tutorial objective loop** for Floor 1:
  - kill rats/slimes
  - collect gold + junk
  - discover safe room
  - unlock and reach staircase before a 5-minute deadline
- Wired immediate timeout failure to `game_over` with a run summary payload on fail/success paths.
- Integrated the new floor systems into `MainGameScene` with a fuller combat/pickup/system pipeline and objective/loadout UI overlays.
- Added floor terrain rendering and safe-room/stair markers in the main scene.
- Added a new **Floor 1 lab** (`floor1-lab`) and registered it in lab loader paths.
- Added `tests/game/floor1-scenario.test.ts` coverage for initialization, loadout transition, timeout fail state, and deterministic enemy director behavior.

## Files Added

- `src/shared/floor1.ts`
- `src/game/floor1Scenario.ts`
- `src/labs/floor1-lab/index.ts`
- `tests/game/floor1-scenario.test.ts`
- `docs/knowledge/handoffs/2026-06-08-floor1-tutorial-vertical-slice.md`

## Files Updated

- `src/core/world.ts`
- `src/engine/scenes/MainGameScene.ts`
- `src/game/index.ts`
- `src/lab-main.ts`
- `src/main.ts`
- `src/shared/loot-tables.ts`

## Validation

- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm test -- --project unit --reporter=dot` ✅
- `npx vitest run tests/game/floor1-scenario.test.ts --project unit --reporter=verbose` ✅
- `npm run verify` ⚠️ consistently fails due pre-existing integration timeout in:
  - `tests/integration/batch-cli.test.ts` (`completes three briefs...` timed out at 60000ms)
  - the same test passes when run in isolation.

## Notes

- Floor 1 “base stats” are currently represented as tutorial stat bonuses (`maxHp`, `moveSpeed`, `pickupRange`) applied at scenario runtime.
- Meta-progression persistence is not implemented yet; only summary hooks are emitted in `world.floor1.runSummary`.
