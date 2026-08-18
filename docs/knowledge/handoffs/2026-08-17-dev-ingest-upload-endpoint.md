# Handoff: Dev ingest upload endpoint wiring

## Systems touched

azure-infra, hud-ux

## Apples

Estimated: 1. Actual: 1.

## Summary

- Fixed the browser run-bundle/survey upload resolver so it honors `VITE_RUNS_INGEST_URL`, the environment key already configured by the dev deploy workflows.
- Added unit coverage proving that the dev deploy workflow key enables the upload path.
- The generated issue #3044 had an automated E2E survey with no player feedback; the repo-side fix was the smallest client wiring correction found while verifying the ingest path.

## Verification

- `npm run test:unit -- tests/unit/run-bundle-upload.test.ts --run`
- `npm run test:e2e -- tests/e2e/run-bundle-upload-browser.test.ts --run`
- `npm run verify:fast`

## Notes

- Attempted to post the required plan comment directly on issue #3044 before editing, but the sandbox token was rejected by GitHub with HTTP 403. The same plan was recorded via session progress before code changes.
- Attempted to fetch the linked Azure blob bundle, but DNS resolution for `crawlersprites.blob.core.windows.net` failed in the sandbox; verification used the issue-provided run ID and survey metadata.
