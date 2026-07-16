# Handoff: PR #1212 blocker recovery

## Date

2026-07-16

## Persona

Systems Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

Estimated 🍎🍎, actual 🍎🍎.

## What changed

- Merged latest `origin/main` into `fix-safe-room-doorway-livelock` and resolved the lone textual conflict in `tests/headless/collision-pair-parity.test.ts` by re-pinning the seed-42 golden to the actual merged-branch headless fingerprint.
- Fixed `BehaviorTreeAI.reset()` / safe-room egress teardown so `safeRoomEgressSuppressFrames` is cleared alongside the other latched egress state.
- Added two behavior-tree regressions:
  - the suppress cooldown survives an outside poll after the no-progress watchdog arms it, and only expires after the intended cooldown window;
  - `reset()` clears that suppress cooldown so a new run/floor can leave the safe room immediately.
- Corrected the original handoff’s validation wording from “all 4 current-main timeout repros” to “3 of 4”, and removed the unsupported “noise floor” conclusion from the aggregate sweep discussion.

## CI / blocker diagnosis

- Investigated Actions run `29526793535` per the recovery protocol.
- `Headless Floor 1 Gate` failed on `tests/headless/collision-pair-parity.test.ts` (seed 42 fingerprint drift).
- `ci` and `Merge gate` were aggregate failures downstream of that red job rather than separate new defects.

## Verification

- `npx vitest run tests/game/behavior-tree-ai.test.ts`
- `npx vitest run tests/headless/collision-pair-parity.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- init --apples 2 --slug safe-room-livelock-pr-recovery --title "fix: recover safe-room livelock PR blockers"`

## Review thread outcomes

- `src/game/ai/bt-ai-provider.ts`: fixed the reset leak for `safeRoomEgressSuppressFrames`.
- `tests/game/behavior-tree-ai.test.ts`: added explicit watchdog/suppress and reset regressions.
- `docs/knowledge/handoffs/2026-07-16-fix-safe-room-doorway-livelock.md`: corrected the 3-of-4 wording and removed the confounded “noise floor” claim.
