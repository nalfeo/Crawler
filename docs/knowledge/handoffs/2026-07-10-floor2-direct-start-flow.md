# Handoff — Floor 2 Direct-Start Flow

**Date:** 2026-07-10  
**Branch:** `nalfeo-floor-2-direct-start-flow`  
**Estimate:** 4 apples 🍎🍎🍎🍎

## Systems touched

quests, inventory, ai-behavior-tree, boss-rooms

## Summary

Implemented direct-start Floor 2 bootstrap and temporary completion wiring, then closed the review-harness blockers from adversarial review:

1. **Direct-start Floor 2 player baseline is now explicit and deterministic.**
   - Added shared level helper (`applyStartPlayerLevel`) and used it in both the Floor 2 scenario and headless runner.
   - `initializeFloor2Scenario` now applies a direct-start preset: level 5, deterministic stat-point spending, immediate stat recompute, and Merchant's Magic Charm equipped in the neck slot.
   - Floor 2 starter weapon equip now routes through the equipment-aware helper (`equipStarterOrFallback`) instead of direct active-weapon assignment.

2. **Temporary Floor 2 closeout now starts the exit quest when resource-room stairs pop.**
   - Added `FLOOR2_LEAVE_FLOOR_QUEST_ID` and `floor2-leave-floor` quest (`goalId: floor2.objective.staircaseDiscovered`).
   - When Floor 2 victory opens the resource room, stairs spawn and the leave-floor quest is accepted/tracked.
   - `confirmFloor2StairDescend` now sets the stair goal, runs `questSystem(world)` immediately, then flips to `safe_room`, so the quest reliably completes before scene transition.
   - `autoVictoryOnStart` now reuses the same Floor 2 victory latch path (`latchFloor2Victory`) so it cannot bypass stair/quest handoff.

3. **Resolved runtime coupling and headless progression parity gaps.**
   - Moved stat allocation policy into neutral module `src/game/scenarios/playerStatAllocationPolicy.ts` and kept compatibility via re-export from `src/game/ai/auto-progression.ts`.
   - Headless runner no longer reports Floor 2 victory on `floor2-victory` alone; it now requires actual exit completion (stairs discovered / leave-floor quest complete / `safe_room`).
   - Added `autoFloor2ProgressionSystem` to headless auto-actions so Floor 2 stairs are confirmed in radius (matching Floor 1 auto-descend behavior).

4. **Fixed data/runtime mismatch in den-unlock kill target templates.**
   - `buildDenUnlockQuestPack` now uses `archetype.killTarget` instead of a hardcoded constant so authored quest archetype data controls the objective target.

## Files changed

- `src/game/floor2Scenario.ts`
- `src/game/ai/headless-runner.ts`
- `src/game/ai/auto-progression.ts`
- `src/game/scenarios/playerLevelProgression.ts` (new)
- `src/game/scenarios/playerStatAllocationPolicy.ts` (new)
- `src/shared/quest-types.ts`
- `src/shared/data/quests.floor2.json`
- `tests/unit/floor2-scenario-initialization.test.ts`
- `tests/unit/quest-types.test.ts`
- `tests/integration/floor2-victory-pipeline.test.ts`
- `tests/headless/floor2-completion.test.ts`
- `tests/unit/floor2-den-unlock-selection.test.ts`
- `docs/knowledge/review-ledgers/2026-07-10-floor2-direct-start-flow.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-10-floor2-direct-start-flow.json`

## Verification run

- `npm run verify:fast` ✅
- `npx vitest run tests/headless/floor2-completion.test.ts` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-10-floor2-direct-start-flow.review-ledger.json` ✅

## Remaining gaps

- Floor 2 direct-start baseline is currently unconditional in `initializeFloor2Scenario`; this is correct for the current direct-start-only Floor 2 entry model, but should be revisited if true Floor 1→Floor 2 carry-over is introduced in-session.
