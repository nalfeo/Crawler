## Systems touched

quests, hud-ux

## Summary

Implemented issue #4276 by extending the shared scenario presentation contract
with optional blocking milestone-modal metadata. Floor 1's quota milestone now
opens a non-cancellable acknowledgement modal that says the first leg is
complete and directs the crawler back to the Broker for the next quests.

The real MainGameScene pauses simulation while the modal is open, restores the
previous pause state on acknowledgement, and reuses the existing
shown-milestone latch so the handoff cannot repeat. A deterministic E2E probe
primes the live Floor 1 objective through the shipped scene and verifies the
modal copy, pause behavior, acknowledgement, and no-repeat behavior.

## Apples

- Verdict: recommended
- Estimated: 3🍎
- Actual: 3🍎

## Validation

- `npm run typecheck` ✅
- `npx vitest run tests/unit/scenario-definitions.test.ts` ✅
- `npx vitest run --project e2e tests/e2e/floor1-quota-completion-modal.test.ts` ✅
- `npm run format:check` ✅
- `npm run verify:fast` ✅

## Observe before done

- The real `main-scene-probe-lab` Floor 1/MainGameScene artifact opened the
  configured blocking modal after the quota objective was completed, held the
  simulation frame count steady, resumed after Enter, and did not reopen after
  additional simulation frames.
