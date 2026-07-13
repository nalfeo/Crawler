# Handoff: Automated issue retention

## Date

2026-07-11

## Persona

Producer -> DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated: 3 apples

Actual: 3 apples

Verdict: Exact - two workflow migrations, one shared helper, focused tests, and
live issue cleanup stayed within the planned medium infrastructure slice.

## What Was Done

- Closed all 51 open `asset-request` issues as not planned at the maintainer's
  direction.
- Closed 28 superseded automated reports, retaining only Chronicle issue #821
  and nightly mutation issue #1028.
- Added `.github/scripts/tracking-issues/supersede.mjs`, which keeps the newly
  filed report, excludes pull requests, comments on older matching reports, and
  closes them as not planned.
- Updated Docs Update to treat legacy `[Chronicle]` reports and current
  `docs-update: YYYY-MM-DD findings` issues as one stream.
- Updated Nightly Mutation to retain only the latest dated regression without
  touching `nightly-mutation: baseline update needed`.
- Serialized each report-filing job so overlapping manual and scheduled runs
  cannot close one another's newly created report.
- Added deterministic mocked-Octokit coverage for stream filtering, legacy
  migration, no-op retries, and cleanup failure propagation.

## Key Decisions Made

- Create the replacement issue before closing older reports. API failures may
  temporarily leave duplicates, but never leave a stream with zero reports.
- Use anchored title regular expressions instead of broad prefixes so mutation
  baseline-update issues cannot be closed accidentally.
- Keep the reusable helper outside `ci-recovery`; tracking-report retention has
  different ownership and API conventions.

## Review Harness

- Ledger:
  `docs/knowledge/review-ledgers/2026-07-11-automated-issue-retention.review-ledger.json`
- Plan review: Claude Sonnet 5, approved with seven adopted refinements;
  divergence `minor`.
- Code review: Claude Opus 4.8, round 1 clean.

## Validation

- `npm run test:guards` passed, including 4 tracking-issue retention tests.
- `npm run verify:fast` passed.
- `npm run verify` passed.

## Blockers

None.
