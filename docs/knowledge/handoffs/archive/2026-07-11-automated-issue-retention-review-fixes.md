# Handoff: Automated issue retention review fixes

## Date

2026-07-11

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated: 2 apples

Actual: 2 apples

Verdict: Exact - the follow-up stayed bounded to workflow/report freshness guards,
targeted tests, and required review artifacts.

## What Was Done

- Reworked `.github/scripts/tracking-issues/freshness.mjs` so a run is treated as
  stale only when a newer matching tracking issue was actually filed on the same
  branch.
- Added hidden workflow-run metadata stamping to newly created docs-update and
  nightly-mutation tracking issues so later runs can compare run numbers
  deterministically.
- Added the same freshness gate to `docs-update.yml`, so an older queued docs run
  can no longer create a report after a newer one already filed.
- Kept the nightly mutation report gate, but switched it from workflow-run
  ordering to filed-issue ordering.
- Updated the mocked tracking-issues tests to cover the new “newer filed report”
  behavior.

## Key Decisions Made

- Do not suppress a report merely because a newer workflow run exists; only a
  newer report issue with stamped run metadata can supersede the current run.
- Store run metadata in hidden HTML comments inside the issue body so the guard
  is deterministic and does not require GitHub Actions REST permissions.
- Preserve the existing issue-retention helper flow: create the replacement issue
  first, then close older matching reports.

## Review Harness

- Ledger:
  `docs/knowledge/review-ledgers/2026-07-11-automated-issue-retention-review-fixes.review-ledger.json`
- 2-apple change; no plan/code/multi-model review stages required.

## Validation

- `node --test .github/scripts/tracking-issues/*.test.mjs` passed.
- `npm run test:guards` passed.
- `npm run verify:fast` passed.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-11-automated-issue-retention-review-fixes.review-ledger.json` passed.
- `npm run verify:pr-prereqs` passed after adding the ledger + handoff.

## Blockers

None.
