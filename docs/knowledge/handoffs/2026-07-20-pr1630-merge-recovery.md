# Handoff: PR #1630 merge-conflict recovery

## Date

2026-07-20

## Persona

Producer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples.

## What changed

- Merged `origin/main` into `copilot/nalfeo-d1-deterministic-equipment-generator-another-one` to clear the PR #1630 dirty-merge blocker without rewriting branch history.
- Resolved the generated-equipment conflicts by preserving the branch's newer source-ownership grant flow, keeping `main`'s deferred active-weapon snapshot validation, and removing duplicate re-exports introduced in `src/game/index.ts`.
- Updated `scripts/agent/verify-fast.sh` and its regression test to recognize `vitest.config.ts` as a supported root TypeScript path while still rejecting other unsupported root TS files.

## Observe before done

- Before: PR #1630 reported `mergeable_state: dirty`, and a local `git merge --no-commit --no-ff origin/main` reproduced nine conflicts across generated-equipment runtime, carryover, and tests.
- After: the merge staged cleanly with no remaining unmerged files, and the branch passed both targeted generated-equipment tests and the full required verification suite.

## Verification run

- `npx vitest run --project unit tests/game/equipment-ability-grants.test.ts tests/game/generated-equipment-generator.test.ts`
- `npx vitest run tests/property/generated-equipment-generator.property.test.ts`
- `npx vitest run --project integration tests/integration/generated-equipment-runtime.test.ts`
- `npx vitest run --project unit tests/unit/verify-fast-typecheck.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None in local verification. GitHub will only clear the merge-conflict blocker after the merge commit is pushed back to the PR branch.
