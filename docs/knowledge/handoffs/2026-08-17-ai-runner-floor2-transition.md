# Handoff — AI Runner Floor 2 transition

## Systems touched

engine-scenes, ai-behavior-tree

## Summary

- Fixed the AI Runner Lab Floor 1 → Floor 2 handoff that remained on the completion loading screen.
- PR #3019 refreshed the next-floor options correctly, but the subsequent Phaser scene restart aborted during shutdown: `RewardOpeningUI.destroy()` called `disableInteractive()` on a display object Phaser had already detached.
- Reward-opening cleanup now skips Phaser-object operations after its container is detached, allowing the scene restart to complete.

## Validation

This work was originally implemented on an abandoned session branch
(`copilot/fix-ai-runner-lab-transition`, 2026-08-17) that was never published
as a PR; it was recovered and rebased onto current `main` in a later session,
per rule #9 re-observing the before/after on the rebased code rather than
trusting the stale pre-rebase claim:

- `npx vitest run tests/unit/reward-opening-ui-visibility-hook.test.ts` ✅ (5/5) on rebased code.
- Re-confirmed the regression before/after directly against the rebased tree: temporarily reverting `src/engine/RewardOpeningUI.ts` to its pre-fix state (the version at rebase base commit `a6e32b6f3`) reproduces the exact failure — `does not touch display objects already detached during scene shutdown` throws `Error: detached display object should not be updated` — then reapplying the fix makes all 5 tests in the file pass again.
- `npm run typecheck -- --pretty false` ✅
- `npm run verify:fast` ✅

## Apples

Estimated: 🍎🍎. Actual: 🍎🍎. Exact — the defect was a localized Phaser teardown lifecycle issue with one regression test.
