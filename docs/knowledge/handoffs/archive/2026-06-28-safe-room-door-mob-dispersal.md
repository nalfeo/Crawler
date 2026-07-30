# Session Handoff: Disperse de-aggro mobs from closed safe-room doors

## Date

2026-06-28

## Persona(s) adopted

Producer → AI/gameplay specialist. The bug touched enemy AI, safe-room/door logic,
and the Floor 1 win-rate gate, so a single focused gameplay fix fit best.

## Routing verdict

✅ right persona — narrow, single-system AI tweak with a clear regression test.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — small, focused AI dispersal change once the wrong door-locking path was abandoned.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

enemies

## What Was Done

Bug: a group of enemies crowded the door to a safe room. Intended behavior: doors
reset to closed when the player is inside (breaking line-of-sight, **not** sealed),
and mobs should quickly peel away from the closed doors.

Root cause: de-aggro idle wander stopped a mob (`setVelocity 0`) when its forward
direction was blocked, so mobs at a closed door camped the threshold.

Fix (`src/game/enemyAISystem.ts`):

- Added `fleeFromDoorDirection()` — sums an outward unit vector from every nearby
  door tile, biased away from the player; returns zero when no doors are in range.
- De-aggro mobs (`avoidDoors`) near a door now flee outward to passable non-safe
  space at `speed*0.7` instead of stalling. A single door-tile scan doubles as the
  proximity check (no separate `isNearDoor` pass) to keep per-frame cost minimal.
- Regression test in `tests/game/enemy-ai.test.ts`: a mob camped on a closed
  safe-room door is steered away.

An earlier door-locking rewrite of `doorSystem.ts` was reverted — door changes were
the wrong layer; dispersal is the correct fix.

## What's Next

- Watch CI; if the wall-time perf guard trips on a runner, it's the documented coarse
  guard, not a regression (frame counts unchanged). Profile before raising the budget.

## Blockers

None. Local headless wall-time guard flaked under heavy machine load (different
seed/weapon each run); all correctness/win-rate asserts pass.

## Branch State

- Branch: `nalfeo-fix-enemy-door-crowding`
- All tests passing: yes (correctness); wall-time perf guard load-flaky locally
- PR created: yes

## Agent-OS Telemetry

No `files/guard-telemetry.jsonl` present.

## Test Results

`npm run verify:fast` — 234 passed. enemy-ai suites — 56 passed. Floor 1 headless gate
correctness/game-time pass; coarse wall-time guard flaked under local load only.

## Key Decisions Made

- Fix at the AI layer (dispersal), not the door layer; doors only reset closed.
- Single door scan per de-aggro near-door mob; do not raise the wall-time budget.
