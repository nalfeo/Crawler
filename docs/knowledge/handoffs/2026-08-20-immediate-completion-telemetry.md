# Handoff: Immediate completion telemetry

## Systems touched: devtools, engine

## Apples

Estimated: 3🍎 — actual: 3🍎. Implemented a medium two-phase telemetry recovery across browser upload wiring, dev-build ingest handling, and regression tests.

## Summary

- Completion run bundles now publish immediately for death, victory, timeout, and quit. `MainGameScene` keeps the completion upload promise so survey submission waits for the completion attempt instead of racing it.
- Survey uploads now send a runId-based append payload (`{ meta: { runId }, survey }`) instead of resending the full run bundle. The dev-build ingest endpoint validates this mode separately, requires the completion bundle to exist, and records survey append state in `survey.json`.
- Survey append retries are idempotent by survey content hash. Existing run issues receive survey feedback as a comment; runs without an issue create/reuse the run issue by `runId`.
- CORS now permits the existing `X-Run-Upload-Mode` header used by completion/survey uploads.

## Verification

- `bash scripts/agent/preflight.sh` — passed.
- `npx vitest run --project unit tests/unit/run-bundle-telemetry.test.ts tests/unit/run-bundle-upload.test.ts tests/unit/main-game-scene-run-bundle.test.ts tests/unit/dev-build-ingest-handler.test.ts tests/unit/dev-build-ingest-validation.test.ts` — 39/39 passed.
- `npm run lint -- --quiet` — passed.
- `npm run typecheck` — passed.
- `codeql_checker` — 0 alerts (JavaScript analysis skipped by tool due to database size).
- Review ledger validated after code-review and independent-grade stages.

## Observe before done

Before: unit coverage encoded the old behavior where death/victory run bundle uploads were deferred until survey skip/submit.
After: `tests/unit/main-game-scene-run-bundle.test.ts` verifies all terminal outcomes emit completion telemetry immediately and survey append waits for the completion upload promise.

## Follow-up

None known.
