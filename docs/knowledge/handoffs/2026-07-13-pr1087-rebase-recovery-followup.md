# Handoff — PR #1087 rebase recovery follow-up

**Date:** 2026-07-13  
**Branch:** `copilot/fix-hud-ux-consistency`  
**Session slug:** pr1087-rebase-recovery-followup

## Systems touched

hud-ux, mobile-ux, ci-policy

## Apple estimate

- Declared: **2 apples**
- Actual: **2 apples**
- Verdict: **on-target**

## Summary

Recovered PR #1087 from the `54c4c902` rebase blocker by rebasing onto current `origin/main`, then fixing the two small follow-up regressions surfaced locally during post-rebase validation:

- restored the `MOBILE_CORNER_BUTTON_DEPTH` alias used by the rebased HUD Skills-dismiss path
- removed a duplicated `it(...)` declaration in `tests/unit/main-game-scene-mobile-ui.test.ts`

## Files touched

- `src/engine/scenes/MainGameScene.ts`
- `tests/unit/main-game-scene-mobile-ui.test.ts`
- `docs/knowledge/handoffs/2026-07-13-pr1087-rebase-recovery-followup.md`

## Validation

- `npx vitest run tests/unit/main-game-scene-mobile-ui.test.ts`
- `npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None locally. Fresh GitHub checks still need to run on the rebased head after push.
