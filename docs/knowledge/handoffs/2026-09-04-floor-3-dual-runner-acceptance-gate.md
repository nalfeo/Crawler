# Floor 3 dual-runner acceptance gate

## Date

2026-09-04

## Persona

QA Engineer

## Systems touched

ai-behavior-tree, hud-ux

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Summary

The shared deterministic seed 3539 now proves Floor 3 completion through both
real execution paths. The headless gate uses `runHeadless` with production
`BehaviorTreeAI`; the visual E2E boots the AI Runner Lab's shipped
`MainGameScene` and observes its autonomous completion.

The visual test no longer teleports the player to stairs. It waits for the
production AI to reach the stairs, confirms the real modal callback, and
asserts the post-exit `safe_room` state. The retired debug stair-jump hook can
no longer mask a missing exit route. Failure output includes the complete modal
trace and the latest objective-navigation history.

## Files touched

- `src/game/floor3Scenario.ts`
  - Routes deterministic kept-Companion selection through the public scenario
    callback rather than directly mutating the selected entity.
- `src/labs/ai-runner-lab/index.ts`
  - Removes the direct debug stair teleport/interaction hook.
- `tests/headless/floor3-completion.test.ts`
  - Emits Floor 3 progression context when the real headless run fails.
- `tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts`
  - Requires autonomous real-exit completion, preserves modal callback and
    outside-spawn evidence, and reports modal/objective history on failure.

## Real artifact evidence

- Before: the visual test invoked `__aiRunnerJumpToStairs()` after the Final
  Four, directly moving the player and queuing interaction.
- After: the same seed reached the real exit autonomously in the AI Runner Lab
  and entered the production post-exit `safe_room` after the stair callback.
- The visual run observed all required surfaces through their actual callbacks:
  intro/starter once, 6 Studio-versus cards, 5 poach cards, 4 Final Four cards,
  kept-Companion selection, and stair descent. It also remained alive outside
  spawn for at least 10 consecutive simulated seconds.

## Verification run

- Focused Floor 3 headless completion: passed.
- Focused Floor 3 real-scene E2E acceptance: passed.
- Floor 1, Floor 2, and Floor 3 headless runner regressions: 19/19 passed.
- `npm run verify:fast`: 812 files / 11,483 tests passed.

## Unresolved issues

This is possibility evidence for one deterministic seed only; it does not make
or imply a balance or win-rate claim.
