# Handoff: CI repair priority and capacity throttling

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3 apples, actual 3 apples.

## What changed

- Added `ci-repair` priority ordering to merge-train admission.
- Added `normal` and `priority-only` modes to the CI recovery router.
- Kept directly triggered repair work dispatchable while throttling ordinary sweeps in `priority-only`.
- Applied both `ci-incident` and `ci-repair` labels to incident issues and documented carrying `ci-repair` to repair PRs.
- Added regression coverage for merge-train ordering, train-enabled recovery, and normal-mode fallback.

## Operating guidance

During GitHub Actions or runner-capacity incidents, set the repository variable
`CI_RECOVERY_PRIORITY_MODE=priority-only`. If `main` health is red, disable the
merge train until health returns; the existing main-health gates remain fail-closed.

## Verification

- Focused merge-train and CI-recovery tests: 70 passed.
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-ci-repair-priority.review-ledger.json`
- Secret scan passed for changed files.

## Unresolved issues

- Automatic trusted label propagation from an incident issue to its generated PR was not added; the incident automation instructions ask the repair agent to carry `ci-repair`.
