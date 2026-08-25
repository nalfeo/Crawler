# Handoff: Config-driven Floor 1 AI task merge recovery

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-runner

## Apples

Estimated 2🍎, actual 2🍎.

## What Was Done

- Merged `origin/main` into PR #3421 without rewriting its five existing commits.
- Resolved the `bt-ai-provider.ts` conflict by retaining the config-driven task
  dispatcher and porting main's unlocked-stair suppression exception into the
  generic `post-stairs` operation path.
- Preserved the merge as a true two-parent commit.

## Validation

- `npx vitest run tests/game/behavior-tree-ai.test.ts tests/headless/floor1-throwing-knife11-release-regression.test.ts`
  — 142 tests passed.
- `bash scripts/agent/verify-fast.sh` — 144 files / 2,368 tests passed, plus
  typecheck, lint, integrity checks, and silent merge-revert validation.

## Next / Follow-up

- CI should recompute PR mergeability from the repaired branch head.
