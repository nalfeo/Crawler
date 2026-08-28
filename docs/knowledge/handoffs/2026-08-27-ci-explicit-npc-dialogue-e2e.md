# Handoff — CI recovery for explicit NPC dialogue E2E

## Systems touched

hud-ux

## Summary

- Diagnosed main CI run `33122682207`: `E2E Visual — Game/UI` failed in `tests/e2e/main-game-scene-ui-exclusivity.test.ts` while verifying the explicit NPC dialogue interaction path.
- Reproduced the failure locally: after opening dialogue by NPC click, the test pressed Escape and immediately clicked the Talk hint before the scene had consumed Escape and restored the hint, so the click could be dropped while dialogue was still active.
- Made the E2E wait for `conversationOpen=false`, then reacquire the restored Talk hint bounds before clicking the Talk affordance.

## Apples

- Estimated: 2🍎
- Actual: 2🍎
- Verdict: exact — CI log diagnosis plus a focused test synchronization fix.

## Validation

- `npm run test:e2e -- tests/e2e/main-game-scene-ui-exclusivity.test.ts -t "requires an explicit NPC interaction" --reporter=verbose` ✅
- `npm run test:e2e -- tests/e2e/main-game-scene-ui-exclusivity.test.ts --reporter=verbose` ✅ (21 tests)

## Runtime observation

- Before: the real `MainGameScene` probe E2E timed out waiting for `Talk button opened dialogue` with `conversationOpen=false` after the Escape-then-click sequence.
- After: the same real-scene E2E waits for dialogue closure, confirms the Talk hint is restored, then opens dialogue through the Talk hint successfully.
