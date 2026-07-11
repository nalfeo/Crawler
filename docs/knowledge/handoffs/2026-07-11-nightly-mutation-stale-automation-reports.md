# Handoff: Nightly mutation stale automation reports

## Date

2026-07-11

## Persona

DevOps Engineer

## Systems touched

<!-- tooling / workflow session; no runtime gameplay systems changed -->

## Apples

1🍎 exact — small workflow/tooling fix: remove stale tracked report artifacts, ignore them going forward, and clear the aggregation directory before each reporting workflow run.

## What Was Done

Fixed the real cause behind issue #1028's bogus nightly-mutation report.

- Confirmed the reported ADR findings were **not reproducible** locally and were
  already absent from the exact nightly run SHA.
- Traced the mismatch to **tracked historical JSON summaries** under
  `.automation-reports/`. The nightly aggregation step was reading every JSON in
  `$AUTOMATION_REPORT_DIR`, and the workflows only `mkdir -p`'d that directory,
  so fresh scheduled runs could publish stale findings from old checked-in files.
- Removed the tracked `.automation-reports/*.json` snapshots.
- Added `.automation-reports/` to `.gitignore`.
- Hardened all report-aggregating workflows (`nightly-mutation`,
  `security-review`, `test-health`, and `docs-update`) to `rm -rf` the
  automation report directory before recreating it, so each run only aggregates
  fresh summaries from that run.

## Files touched

- `.github/workflows/nightly-mutation.yml`
- `.github/workflows/security-review.yml`
- `.github/workflows/test-health.yml`
- `.github/workflows/docs-update.yml`
- `.gitignore`
- removed tracked files under `.automation-reports/`
- `docs/knowledge/review-ledgers/2026-07-11-nightly-mutation-stale-automation-reports.review-ledger.json`

## Verification run

- `npx tsx scripts/agent/docs/check-adr-consistency.ts` ✅ (`0 finding(s), 0 blocking`)
- `npm run verify:fast` ✅
- Targeted `/tmp` repro of the workflow cleanup + `aggregate-report.ts` ✅
  (only the fresh summary appeared in the generated report body)
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-11-nightly-mutation-stale-automation-reports.review-ledger.json` ✅
- `npm run verify` ✅ after adding the required handoff + review ledger

## Unresolved issues

- None in this fix. The informational `docs-check-readme-commands` drift still
  exists as a separate docs backlog, but it was never the source of the bogus
  nightly mutation regression issue.

## Recommended next steps

- If any other workflow starts aggregating per-step JSON summaries into
  `.automation-reports/`, use the same clear-then-create pattern before writing
  fresh outputs.
