# Terminal Run Survey Reset Guard

**Date:** 2026-09-02  
**Persona:** Producer  
**Apples:** 2🍎 estimated / 2🍎 actual (exact)

## Systems touched

hud-ux

## Summary

Fixed the terminal-run survey regression that let the scene restart or reload while the player was still submitting or skipping end-of-run feedback. The survey modal now traps keyboard bubbling and the death-screen restart/quit actions refuse to fire until the survey is closed, while still allowing the completion upload to settle before the survey append request is sent.

## Files touched

- `src/engine/RunSurveyUI.ts`
- `src/engine/scenes/MainGameScene.ts`
- `tests/unit/run-survey-ui.test.ts`
- `tests/unit/main-game-scene-run-bundle.test.ts`

## Verification

- `npx vitest run tests/unit/run-survey-ui.test.ts tests/unit/main-game-scene-run-bundle.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Unresolved issues

None.

## Recommended next steps

Keep the terminal run survey modal open until submit or skip completes, then allow the existing death/victory flow to continue without any mid-survey reset path.
