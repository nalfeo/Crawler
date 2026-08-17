# Handoff — AI Runner Floor 2 transition

## Systems touched

engine-scenes, ai-behavior-tree

## Summary

- Fixed the AI Runner Lab Floor 1 → Floor 2 handoff that remained on the completion loading screen.
- PR #3019 refreshed the next-floor options correctly, but the subsequent Phaser scene restart aborted during shutdown: `RewardOpeningUI.destroy()` called `disableInteractive()` on a display object Phaser had already detached.
- Reward-opening cleanup now skips Phaser-object operations after its container is detached, allowing the scene restart to complete.

## Validation

- `npx vitest run tests/unit/reward-opening-ui-visibility-hook.test.ts` ✅
- `npm run typecheck -- --pretty false` ✅
- `npm run verify:fast` ✅
- Live AI Runner Lab browser probe: forced Floor 1 completion stayed on Floor 1 before the fix with `Text.disableInteractive` throwing during shutdown; after the fix it restarted into Floor 2 (`worldState: playing`).

## Apples

Estimated: 🍎🍎. Actual: 🍎🍎. Exact — the defect was a localized Phaser teardown lifecycle issue with one regression test.
