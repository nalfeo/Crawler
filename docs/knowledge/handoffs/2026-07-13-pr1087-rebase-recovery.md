# Handoff — PR #1087 rebase recovery

**Date:** 2026-07-13  
**Branch:** `copilot/fix-hud-ux-consistency`  
**Session slug:** pr1087-rebase-recovery

## Systems touched

hud-ux, mobile-ux, ci-policy

## Apple estimate

- Declared: **2 apples**
- Actual: **2 apples**
- Verdict: **on-target**

## Summary

Recovered PR #1087 from the `fd4e1f04` rebase blocker by rebasing the branch onto current `origin/main` and resolving the live HUD UX conflicts in favor of the shipped `abilityLoadoutUI` path.

## Key conflict resolutions

- Kept the real abilities surface wired through `abilityLoadoutUI` instead of reverting to the older `modalPicker` implementation.
- Preserved the Skills dismiss shortcut behavior above the abilities surface (`MODAL_DISMISS_BUTTON_DEPTH`) and the `[B]` close path that runs before blocked input would leak through.
- Preserved the probe/e2e seam that counts the abilities loadout as a primary surface in `main-scene-probe-lab`, so the real-scene exclusivity test still observes the right runtime surface.
- Kept the stronger `main-game-scene-ui-exclusivity` coverage for keyboard, pointer, dismiss-button, and held-input regressions.

## Files touched

- `src/engine/scenes/MainGameScene.ts`
- `src/labs/main-scene-probe-lab/index.ts`
- `tests/e2e/main-game-scene-ui-exclusivity.test.ts`
- `tests/unit/main-game-scene-mobile-ui.test.ts`
- `docs/knowledge/handoffs/2026-07-13-hud-ux-consistency.md`
- `docs/knowledge/handoffs/2026-07-13-pr1087-rebase-recovery.md`

## CI / blocker status

- Current blocker was rebase-only; no review-thread blockers were listed in the recovery comment.
- Checked recent branch workflow runs after fetch/rebase context: substantive PR runs on the old head were green, with only the current Copilot recovery run still in progress.

## Validation

- `npx vitest run tests/unit/main-game-scene-mobile-ui.test.ts`
- `npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None in local validation; fresh post-rebase GitHub checks still need to run on the updated head.
