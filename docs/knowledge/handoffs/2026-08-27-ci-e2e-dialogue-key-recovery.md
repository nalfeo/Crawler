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

## PR metadata repair (2026-08-29)

PR #3877 inherited its title and body unchanged through two rounds of quarantine repair
(#3786 → #3792 → #3829 → #3877). Both still advertised an E2E code change — replacing
`page.keyboard.press('e')` with an explicit `keyboard.down`/`keyboard.up` hold — that is
not on this branch. The Copilot reviewer flagged the mismatch as materially misstating
what reviewers would merge.

Before relabeling, both remedies were checked against the real diff:

- `git diff origin/main...HEAD --stat` → only this handoff file; no `tests/` diff.
- `tapKeyUntil(page, 'e', ...)` is present on `origin/main` in
  `tests/e2e/main-game-scene-ui-exclusivity.test.ts`.

The branch's original commit `7ca01f7` held the key across the assertion. That does **not**
address the drain case: a held press is still a single `JustDown` and is swallowed by
`clearPendingInteractionInput()` exactly as a tap is. `main`'s `tapKeyUntil` re-taps until
the probe-observed state settles and is strictly the better fix, so the test work was
superseded rather than silently dropped. Docs-only was therefore the correct remedy, and
the title and body were rewritten from the real diff per `AGENTS.md` rule 10.

## Unresolved issues

- None known.

## Recommended next steps

- Let CI rerun the full E2E visual job on the PR branch and confirm the repository-level aggregate returns green.
