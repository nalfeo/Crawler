# Release Report Shard Recovery

## Date

2026-08-14

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2 apples estimated, 2 apples actual (exact). The recovery stayed within the deploy workflow and focused workflow tests.

## What changed

- Confirmed the branch is cleanly merged with `origin/main` after unshallowing and fetching main.
- Kept `baseline-sweep` dependent on `release-report-sweep`; the current regression test already covers that dependency and matching release gate.
- Made report-leg publication skip incomplete shard sets unless all 15 shards and all 150 runs are present for the leg.
- Fixed a localized TypeScript issue in the workflow-parity test by stringifying the YAML matrix args field before splitting.

## Evidence

- Separate validator confirmed the dependency-thread finding was already addressed at current head.
- Separate validator confirmed the partial-shard publication finding was still applicable.
- `npm test -- --run tests/unit/deploy-workflow-gating.test.ts tests/unit/sweep-legs-workflow-parity.test.ts`
- `npm run typecheck`
- Deploy workflow YAML parse check
- `npm run format:check`
- `npm run verify:pr-prereqs`
- `npm run verify:fast`

## What's next / blockers

No known local blockers. Reply to the two exact review-thread comments after pushing the consolidated repair commit so CI Recovery can reconcile them.
