# Azure dev-build ingest Function

## Date

2026-08-14

## Persona

DevOps Engineer

## Systems touched

azure-infra, ci-policy

## Apples

3 apples estimated, 3 apples actual. The change adds a deployable Azure
Functions v4 HTTP proxy, storage lifecycle/provisioning, GitHub issue filing,
and validation coverage without changing the game client.

## What changed

- Added `functions/dev-build-ingest`, an anonymous `POST /runs` Function with
  an 8 MiB request cap, PNG validation, survey validation, exact configurable
  CORS, and blob-backed per-IP rate limiting.
- Every accepted bundle is stored in the private `playtest-runs` container.
  Optional screenshots are stored as PNG blobs; signed seven-day links are used
  for issue bodies.
- GitHub issues are gated on a survey or explicit `file_issue` request and use
  `CRAWLER_CI_PAT`. A pending blob claim and issue marker make retries safe
  against duplicate issue creation.
- Added Function App and storage Bicep, lifecycle cleanup for rate-limit
  markers, Azure setup environment documentation, and root TypeScript/verify
  support for the new Function package.

## Configuration

Provision the existing storage account with `infra/azure-storage.bicep`, then
deploy `infra/dev-build-ingest.bicep`. Set the `CRAWLER_CI_PAT` Function App
setting to a repository-scoped token with issue write permission. The client
endpoint is the Function hostname with `/runs`; no credential belongs in the
Pages bundle.

## Verification

- Function package `npm run build`: passed.
- `npm run test:unit -- tests/unit/dev-build-ingest-validation.test.ts --run`:
  5 tests passed.
- `npm run verify:fast`: passed.
- 3-apple review ledger validated with plan review, two code-review rounds, and
  an independent passing grade:
  `docs/knowledge/review-ledgers/2026-08-14-dev-build-ingest-function.review-ledger.json`.

## Follow-up

PR3/PR4 should send a stable `meta.runId` so client retries reuse the same
bundle path. The current blob-backed rate limiter is intentionally a bounded
soft limit; if traffic grows materially, move the counter to an atomic
server-side rate-limit service.
