# Dev-build survey and auto-upload publication handoff

## Summary

PR3 completes the client-side dev-build feedback loop: post-run survey submission, silent RunBundle upload, endpoint wiring, and deployment documentation for the merged Azure ingest proxy.

## Files touched

- `src/shared/playtest-survey.ts`
- `src/shared/run-bundle-telemetry.ts`
- `src/engine/RunSurveyUI.ts`
- `src/engine/scenes/MainGameScene.ts`
- `src/bootstrap/floor-main-scene-options.ts`
- `scripts/agent/health/fun-score-lib.ts`
- `tests/unit/run-bundle-telemetry.test.ts`
- `tests/unit/fun-score-input.test.ts`
- `vite.config.ts`
- `infra/PLAYTEST_RUNS_SETUP.md`
- `infra/playtest-runs-function.bicep`

## Verification run

- `npm run verify:fast` passed.
- 14 test files and 138 tests passed.
- Prettier check passed before push.

## Unresolved issues

None known. Azure provisioning and endpoint secret injection remain operator deployment steps documented in `infra/PLAYTEST_RUNS_SETUP.md`.

## Recommended next steps

Merge this PR after CI, provision the Function and storage resources from the Bicep template, configure `CRAWLER_CI_PAT` and storage settings, then set `VITE_CRAWLER_RUNS_API_ENDPOINT` for the dev build deployment.
