# Handoff — CI E2E dialogue key recovery

## Systems touched

hud-ux

## Summary

- Diagnosed repository-level CI run `33122808922` on `main`; the only real failing job was `E2E Visual — Game/UI`, with `Merge gate` and `ci` failing as downstream aggregators.
- Root cause was the `main-game-scene-ui-exclusivity` E2E using `page.keyboard.press('e')` for a Phaser `JustDown`-sampled interaction, which can release before the game frame samples it.
- Updated the E-key dialogue assertion to hold `E` until the real `MainGameScene` probe observes dialogue, then release it in `finally`.

## Files touched

- `tests/e2e/main-game-scene-ui-exclusivity.test.ts`
- `docs/knowledge/handoffs/2026-08-27-ci-e2e-dialogue-key-recovery.md`

## Verification

- `bash scripts/agent/preflight.sh` ✅
- `npx vitest run tests/e2e/main-game-scene-ui-exclusivity.test.ts --project e2e -t "requires an explicit NPC interaction"` ✅
- `npm run verify:fast` ✅ (147 files / 2397 tests)
- `npm run verify:pr-prereqs` ✅

## Runtime observation

- Before: CI run `33122808922` timed out waiting for `E opened dialogue` even though the probe had a primed nearby NPC and no blocking UI surface.
- After: the focused real-scene E2E passes when `E` is held until `conversationOpen` is observed, preserving the same shipped E-key dialogue behavior without changing production code.

## Unresolved issues

- None known.

## Recommended next steps

- Let CI rerun the full E2E visual job on the PR branch and confirm the repository-level aggregate returns green.
