# Terminal Run Survey Reset Guard

**Date:** 2026-09-02  
**Persona:** Producer  
**Apples:** 2🍎 estimated / 2🍎 actual (exact)

## Systems touched

hud-ux

## Summary

Fixed the terminal-run survey regression that let the scene restart or reload while the player was still submitting or skipping end-of-run feedback. The survey modal keeps focus for feedback entry, production capture handlers now ignore survey-active keyboard events, and the death-screen restart/quit confirmation path is rejectable until the survey is closed, while still allowing the completion upload to settle before the survey append request is sent.

## Files touched

- `src/engine/RunSurveyUI.ts`
- `src/engine/GameOverUI.ts`
- `src/engine/InputCapture.ts`
- `src/engine/ModalPickerUI.ts`
- `src/engine/scenes/MainGameScene.ts`
- `src/labs/main-scene-probe-lab/index.ts`
- `tests/e2e/helpers/main-scene-probe.ts`
- `tests/e2e/run-bundle-completion-telemetry.test.ts`
- `tests/unit/input-capture.test.ts`
- `tests/unit/run-survey-ui.test.ts`
- `tests/unit/main-game-scene-run-bundle.test.ts`

## Verification

- Before-fix real-stack reproduction: temporarily restored the old `GameOverUI` close-before-hook behavior, then ran `npx vitest run --project e2e tests/e2e/run-bundle-completion-telemetry.test.ts -t "keeps the real game-over picker usable" --reporter=dot`; it failed because `blockedConfirmState.gameOverOpen` was `false` after driving the real game-over Enter handler while the survey was visible.
- After-fix real-stack observation: `npx vitest run --project e2e tests/e2e/run-bundle-completion-telemetry.test.ts --reporter=dot` boots the real `MainGameScene` via `main-scene-probe-lab`, forces `game_over`, observes the survey and game-over picker, drives the game-over Enter handler while the survey owns input, skips the survey, and confirms the picker remains open (3/3 tests passed).
- `npx vitest run tests/unit/input-capture.test.ts tests/unit/main-game-scene-run-bundle.test.ts --reporter=dot`
- `npx vitest run tests/unit/run-survey-ui.test.ts tests/unit/main-game-scene-run-bundle.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Unresolved issues

None.

## Recommended next steps

Keep the terminal run survey modal open until submit or skip completes, then allow the existing death/victory flow to continue without any mid-survey reset path.
