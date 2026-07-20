# Handoff: PR #1630 merge recovery round 4

## Date

2026-07-20

## Persona

DevOps Engineer

## Systems touched

ci-policy, inventory

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Recovered PR #1630 from a fresh drift conflict against `origin/main` by merging main into the branch again and reconciling the `playerCarryover`/achievement-source tracking overlap without dropping this PR's deterministic equipment-scoring work.

## What changed

- Merged `origin/main` into `copilot/nalfeo-d1-deterministic-equipment-generator-another-one`.
- Resolved `src/core/world.ts` to keep the current `AbilityStateLike` world contract alongside main's carried achievement-fact snapshot state.
- Resolved `src/game/playerCarryover.ts` to preserve both the equipment/ability source-ownership carryover logic and main's scoped achievement-fact carryover plus passive re-sync on restore.
- Resolved `tests/unit/player-carryover.test.ts` to retain both the source-ownership regression coverage and the scoped achievement carryover assertions.

## Observe before done

- Before: `git merge --no-commit --no-ff origin/main` failed with content conflicts in `src/core/world.ts`, `src/game/playerCarryover.ts`, and `tests/unit/player-carryover.test.ts`.
- After: the merge had no remaining unmerged paths, `tests/unit/player-carryover.test.ts` passed, and the merged branch passed `npm run verify:fast` plus `npm run verify:pr-prereqs`.

## Verification

- `npx vitest run tests/unit/player-carryover.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None locally. GitHub still needs the pushed merge commit before PR #1630 will stop reporting the stale merge-conflict blocker.
