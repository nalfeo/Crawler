# Handoff: PR #1265 lifecycle contract recovery

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

docs-tooling

## Apples

Estimated 2 apples, actual 2 apples.

## What changed

- Aligned stacked-work `rebase_to_main` validation in `scripts/agent/epics/epic-status-lib.ts` to the same dependency contract used by epic readiness: dependencies must be `validated` (or superseded by a `validated` replacement), not merely `merged`.
- Updated the stacked-work regression in `tests/unit/agent/epic-status.test.ts` so a dependency that is only `merged` now deterministically triggers `stacked.premature-rebase-complete`.
- Refreshed the canonical A0 offline-test evidence hash in `docs/knowledge/epics/floor-2-equipment/epic-state.json` to the exact local anchor commit containing the updated test file, preserving the immutable-evidence contract checked by the offline validator.
- Added the required 2-apple review ledger scaffold at `docs/knowledge/review-ledgers/2026-07-18-pr1265-lifecycle-contract-recovery.review-ledger.json`.

## Verification run

- `npx vitest run tests/unit/agent/epic-status.test.ts`
- `npm run epic:status -- floor-2-equipment`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-pr1265-lifecycle-contract-recovery.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- The outdated review thread about issue `#1264`'s missing pre-code plan comment cannot be satisfied retroactively; this branch now carries only the merge-recovery artifacts plus the lifecycle-contract/tooling fix above.
