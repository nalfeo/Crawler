# Handoff — CI E2E dialogue key recovery

## Systems touched

hud-ux

## Summary

- Diagnosed repository-level CI run `33122808922` on `main`; the only real failing job was `E2E Visual — Game/UI`, with `Merge gate` and `ci` failing as downstream aggregators.
- The original root cause was the `main-game-scene-ui-exclusivity` E2E using a single `page.keyboard.press('e')` for a Phaser `JustDown`-sampled interaction, which can be consumed before the game frame samples it.
- The test repair is already on `main`: `tapKeyUntil` repeats short key holds until the probe-observed state settles, re-arming `JustDown` after input is drained. This PR adds recovery context only; it does not modify the E2E implementation.

## Files touched

- `docs/knowledge/handoffs/2026-08-27-ci-e2e-dialogue-key-recovery.md`

## Verification

- `bash scripts/agent/preflight.sh` ✅
- `git diff origin/main...HEAD -- tests/e2e/main-game-scene-ui-exclusivity.test.ts` ✅ (no E2E test diff)

## Runtime observation

- Before: CI run `33122808922` timed out waiting for `E opened dialogue` even though the probe had a primed nearby NPC and no blocking UI surface.
- After: `main` uses `tapKeyUntil` to re-press `E` until `conversationOpen` is observed, preserving the shipped E-key dialogue behavior without changing production code.

## Unresolved issues

- None known.

## Recommended next steps

- Let CI rerun the full E2E visual job on the PR branch and confirm the repository-level aggregate returns green.
