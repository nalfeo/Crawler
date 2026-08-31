# Handoff: Feedback submit endpoint parity

## Systems touched

hud-ux, azure-infra

## Apples

Estimated: 2. Actual: 2.

## Summary

- Fixed explicit in-game issue submission so it uses the same
  `resolveRunBundleUploadConfig()` endpoint resolver as silent run-bundle upload
  and post-run survey append.
- This restores endpoint-key parity for game feedback submission: browser/window
  overrides, `VITE_RUNS_INGEST_URL`, and the `VITE_CRAWLER_*`/`CRAWLER_*`
  aliases now apply consistently to issue, survey, and silent upload paths.
- Strengthened browser e2e coverage so a real Vite page built with
  `VITE_RUNS_INGEST_URL` proves all three submit paths reach the injected ingest
  URL, and the issue request is identified by `file_issue: true`.

## Observation

- Before: the browser upload e2e only exercised silent run and survey append
  imports; explicit issue submission had a separate, narrower endpoint resolver
  and could drift from the deployed game ingest configuration.
- After: `tests/e2e/run-bundle-upload-browser.test.ts` imports
  `submitFileIssue()` in the same Vite page and observes the issue request going
  to the same injected endpoint as the run and survey requests.

## Verification

- `npm run test:unit -- tests/unit/file-issue.test.ts tests/unit/run-bundle-upload.test.ts --run`
- `npm run test:e2e -- tests/e2e/run-bundle-upload-browser.test.ts --run`
- `npm run verify:fast`
- Code review: clean after review fixes
- CodeQL checker: 0 alerts reported; JavaScript analysis skipped due database
  size limit

## Notes

- No new endpoint, request mode, or dependency was added. The ingest backend
  already treats `file_issue: true` as a normal run-bundle issue payload, while
  survey append continues to use `X-Run-Upload-Mode: survey`.
