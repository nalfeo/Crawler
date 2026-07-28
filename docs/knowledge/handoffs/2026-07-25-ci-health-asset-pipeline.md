# CI Health asset pipeline visibility

**Date:** 2026-07-25  
**Persona:** Producer, routing implementation to DevOps Engineer and validation to QA Engineer  
**Apples:** 3 estimated, 3 actual (exact; tooling-only cap)

## Systems touched

devtools, ci-policy, sprite-pipeline, sprite-workflow

## Outcome

The CI Health canvas now exposes the Asset Request Pipeline as a collapsible,
health-aware section. It shows every open `asset-request` issue's latest observable
attempt stage, a four-stage ingest / generate-and-judge / publish / downstream-promote
timeline, elapsed durations, actionable state details, and direct GitHub links.

The section defaults expanded while work is active, partial, stale, or failing and
collapsed when idle and healthy. A user can manually collapse or expand it; a later
health regression automatically reopens the section.

## Implementation

- Added bounded GraphQL pagination for all open asset-request issues with the latest
  100 comments per issue and explicit truncation reporting.
- Added bounded recent-run queries for `asset-request.yml` and
  `sprite-queue-reconciler.yml`, reusing already-loaded active-run jobs when possible.
- Selected the newest executable asset run rather than allowing a newer skipped issue
  trigger to hide the actual ingest, worker, and publisher steps.
- Parsed GitHub issue progress markers by newest queue/requeue attempt. Statuses are
  explicitly marked observed, inferred, partial, stale, or unknown; no Azure checkpoint
  details are invented.
- Kept `assets/queue` review and `assets/promote` reconciliation as a separate downstream
  lane instead of presenting them as part of the worker run.
- Added sortable issue diagnostics, stage health cards, safe links, partial-data
  warnings, and matching agent-facing summary data.

## Review-driven fixes

The 3-apple plan review added complete issue pagination, attempt segmentation,
downstream-lane separation, observed-link constraints, health-epoch expansion, and
explicit API caps.

Code-review round 1 found five issues, all fixed before a clean round 2:

1. Danger states such as stale, cancelled, timed out, promotion branch without PR, and
   queue branch without PR now render with danger styling.
2. Agent summaries now retain each stage's human label and lane.
3. Stale workflow-step behavior has regression coverage.
4. Truncated histories have a distinct state/count instead of inflating unknowns.
5. Closely related downstream branch-state tone mismatches were aligned.

## Verification

- CI Health focused suite: 46 Node tests passed.
- `npm run verify:fast` passed.
- Review ledger validated:
  `docs/knowledge/review-ledgers/2026-07-25-ci-health-asset-pipeline.review-ledger.json`.
- Reloaded the project extension successfully and exercised `refresh` and `get_summary`.
- Live canvas observation showed 18/18 open asset requests as complete, successful
  ingest / drain / publish stages with durations, and canonical queue PR #1972 in the
  distinct downstream promotion lane.
- Browser observation confirmed 18 rendered issue rows, four rendered stage cards,
  working collapse/expand behavior, and no console errors.

## Files touched

- `.github/extensions/ci-health/extension.mjs`
- `.github/extensions/ci-health/lib/github-client.mjs`
- `.github/extensions/ci-health/lib/model.mjs`
- `.github/extensions/ci-health/renderer.mjs`
- `.github/extensions/ci-health/tests/github-client.test.mjs`
- `.github/extensions/ci-health/tests/model.test.mjs`
- `.github/extensions/ci-health/tests/renderer.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-25-ci-health-asset-pipeline.review-ledger.json`

## Unresolved issues

None for this slice. The canvas intentionally reports only GitHub-observable state; the
Azure checkpoint store remains outside CI Health's trust and API boundary.

## Recommended next steps

Use the new section while the canonical queue PR proceeds through the existing guarded
Sprite queue reconciler. If per-checkpoint internals become necessary later, expose a
sanitized first-party status artifact rather than teaching CI Health to read Azure
credentials directly.
