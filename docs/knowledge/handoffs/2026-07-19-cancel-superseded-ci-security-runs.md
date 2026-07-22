# Session Handoff: Cancel superseded CI and Security runs

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎 estimated, 1🍎 actual (exact).

## What changed

- Added workflow-level concurrency to `.github/workflows/ci.yml` and `.github/workflows/security-review.yml`.
- Concurrency now uses PR-number-scoped groups for `pull_request` events and event/ref/run-id scoped groups for non-PR triggers.
- Enabled cancel-in-progress only for `pull_request` runs so newer synchronize events cancel superseded PR heads without cross-canceling push/schedule/manual runs.
- Added deterministic regression coverage in `tests/unit/pr-workflow-concurrency.test.ts` to assert:
  - PR-only cancel behavior,
  - same-PR grouping stability across pushes,
  - cross-PR isolation,
  - separation between push, schedule, and manual groups.

## Verification

- `npx vitest run tests/unit/pr-workflow-concurrency.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- Could not post the required pre-code issue plan comment via CLI in this environment (`gh issue comment` returned `HTTP 403: 403 Forbidden`).

## Recommended next steps

- Confirm in production metrics that superseded PR-head runner minutes drop toward the target reduction window.
