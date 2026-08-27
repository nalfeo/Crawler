# Handoff: Floor 1 loot sweep PR 3550 recovery

## Systems touched

ai-behavior-tree, ai-headless-runner

## Summary

Merged current `origin/main` into PR #3550 and resolved the overlapping loot-sweep
changes without restoring the unsafe unbounded pre-exit chase. Floor 1 keeps its
mid-run sweep suppression, while pre-exit sweeps retain main's `scanRadius` bound.

An independent review validator confirmed that the unresolved scan-radius thread
was already addressed: the enemy-gate regression now uses the Floor 2 mid-run
fixture with progress goals suppressed. Removed one duplicate Fireball seed-13 row
introduced by the merge.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
- `tests/headless/floor1-release-sweep-loss-regressions.test.ts`
- `tests/unit/ai/bt-loot-sweep.test.ts`

## Verification

- `npx vitest run tests/unit/ai/bt-loot-sweep.test.ts --reporter=verbose` — 17/17 passed.
- `npx vitest run --project headless tests/headless/collision-pair-parity.test.ts tests/headless/floor1-release-sweep-loss-regressions.test.ts --reporter=verbose` — 15/15 passed before duplicate cleanup.
- `npx vitest run --project headless tests/headless/floor1-release-sweep-loss-regressions.test.ts --reporter=verbose` — 9/9 passed after duplicate cleanup.
- `bash scripts/agent/verify-fast.sh` — passed, including 2,368 changed-scope tests.
- `npm run check:silent-reverts` — passed with both intentional main-side document resolutions acknowledged on the merge commit.

## Unresolved issues

None.

## Recommended next steps

Let CI rerun against the merged head and resolve the validated review thread with
the final published commit SHA.
