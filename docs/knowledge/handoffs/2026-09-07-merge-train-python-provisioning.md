# Session Handoff: Merge Train Python Provisioning

## Date

2026-09-07

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎 (exact).

## What Was Done

- Provisioned Python 3.12.10 in the Merge Train Validation sprite-test job after
  immutable candidate materialization.
- Added a bootstrap-safe candidate check: candidates without either proper-pixel-art
  file skip Python dependency provisioning, partial candidates fail, and complete
  candidates install the pinned binary-only requirements, run `pip check`, and compile
  the bridge before Vitest.
- Raised the sprite-test timeout from 8 to 10 minutes for wheel provisioning.
- Extended the workflow-policy regression test to enforce ordering, version and command
  pins, skip/fail-closed behavior, and the timeout floor.

## Validation

- `npx vitest run tests/unit/merge-train-validation-sharding.test.ts --project unit --reporter=dot`
- `npx prettier --check .github/workflows/merge-train-validate.yml tests/unit/merge-train-validation-sharding.test.ts`
- `npm run verify:fast`

## Dependency

This prerequisite must merge to `main` before PR #4460 can pass Merge Train Validation,
because the validation workflow is dispatched from the default branch.

## Blockers

None locally. CI Recovery owns follow-up after publication.
