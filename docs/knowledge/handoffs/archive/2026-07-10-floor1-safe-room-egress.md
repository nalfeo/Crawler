# Handoff — Floor 1 safe-room egress deadlock (seed2 + bow)

**Date:** 2026-07-10  
**Branch:** `nalfeo-fix-floor1-class-b-egress`  
**Session:** Fix floor1 class-b egress

## Systems touched

ai-behavior-tree, ai-pathfinding

## Summary

Fixed a deterministic Floor 1 Class-B deadlock in `BehaviorTreeAI` where LeaveSafeRoom could keep re-coupling movement to a moving threat and oscillate at the safe-room mouth. The egress flow now latches a reachable waypoint, keeps that waypoint stable while still inside safe space, and clears latch state immediately once `playerInSafeRoom` is false.

Key behavior changes in `src/game/ai/bt-ai-provider.ts`:

- Added latched safe-room egress waypoint state (`safeRoomEgressTargetX/Y`, `safeRoomEgressThreatEid`).
- LeaveSafeRoom now reuses only a valid outside-safe waypoint; invalid/arrived waypoints force recomputation.
- Egress decisions set `targetEid = null` during safe-room escape so ENGAGE pursuit fallback cannot retarget to moving enemies mid-egress.
- `computeSafeRoomEgressWaypoint` now returns `null` when no outside-safe reachable waypoint can be resolved (instead of latching an in-safe fallback).
- Poll clears stale egress latch whenever the player is already outside safe space.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
- `tests/game/behavior-tree-ai.test.ts`
- `tests/headless/floor1-safe-room-egress-seed2-bow.test.ts` (new)
- `docs/knowledge/review-ledgers/2026-07-10-floor1-safe-room-egress.review-ledger.json` (new)

## Verification run

- `npm run test -- tests/game/behavior-tree-ai.test.ts tests/headless/floor1-safe-room-egress-seed2-bow.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-10-floor1-safe-room-egress.review-ledger.json`
- `npm run verify` (passes up to prereq gate once ledger + handoff exist)

## Observe-before-done evidence (real artifact)

- Real headless runner repro command (`npm run ai:headless -- --seed 2 --weapon bow --floor floor1 --json`) no longer shows the original multi-minute “Leaving safe room…” deadlock signature.
- Deterministic regression test asserts:
  - first LeaveSafeRoom activation exits safe space within 10 game-seconds,
  - outside-safe streak persists for at least 3 seconds before any possible re-entry,
  - longest in-safe Leaving-safe-room streak remains below 30 seconds,
  - outcome is not timeout.

## Unresolved issues

- None in scope.

## Recommended next steps

- Run PR shepherding/merge flow once this branch is stacked or cherry-picked into the owning parent session branch.
