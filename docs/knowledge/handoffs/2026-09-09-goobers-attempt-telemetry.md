# Session Handoff: Goobers attempt telemetry

## Date

2026-09-09

## Persona

QA Engineer

## Systems touched

ci-policy,mcp-tooling

## Apples

2🍎 estimated

## What Was Done

Added the missing Goobers attempt-telemetry contract for feature-PR runs so every attempt now carries a stable lineage key, per-stage elapsed timings, privacy-safe byte/token metadata, a normalized terminal outcome, and a matched-cohort summary hook for comparing delivery success against canonical-context behavior.

The contract validator now enforces those expectations in `.github/scripts/validate-goobers-contracts-schema.js` and `.github/scripts/validate-goobers-contracts.mjs`, and the regression coverage in `tests/unit/goobers-contracts.test.ts` asserts lineage, missing-field handling, and outcome emission without exposing prompt contents or credentials.

Review follow-up (a contract nobody emits is not telemetry):

- `.github/scripts/goobers/attempt-telemetry.mjs` is the real producer. It reads each slot's `gaggles/*/runs/*/events.jsonl`, derives stage durations from `stage.started`/`stage.finished` pairs (or an explicit duration field), sums privacy-safe byte/token counters, normalizes the run phase into a terminal outcome, and writes a validated `crawler.goobers.run-artifact/v1` to `slot-<n>/diagnostics/attempt-telemetry.json`. Journal-less slots — the failure mode the diagnostics sentinel exists for — still emit an attempt with an explicit `unavailableReason`.
- `goobers-run.yml` runs it between the diagnostics sentinel and the run-journal upload, so the uploaded artifact carries the telemetry. The step is `continue-on-error` because telemetry must never gate a lane that delivered.
- `attemptTelemetryV1` and `cohortSummaryV1` now require `contractVersion`, matching the invocation/output/run-artifact contracts so an unversioned payload fails closed.
- `node .github/scripts/validate-goobers-contracts.mjs` now compiles and fixture-tests the telemetry, cohort-summary, and run-artifact schemas alongside invocation/output, so "All contract validations pass" means all of them.
- `runArtifactV1.cohortSummary` `$ref`s the cohort-summary contract instead of typing it as a bare object, so an unversioned nested cohort can no longer ride along inside a valid run artifact.
- The producer only writes `attempt-telemetry.json` when the record passes its own contract; a violation writes `attempt-telemetry.invalid.txt` and annotates the run instead of publishing a non-conforming artifact.
- Parent lineage keys are only set when the caller can prove them (a rerun mints a new Goobers run ID and resets `GITHUB_RUN_ATTEMPT`); `issue-<n>` remains the shared lineage root.

## Verification

- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run tests/unit/goobers-contracts.test.ts --reporter=dot`
- `node --test .github/scripts/goobers/attempt-telemetry.test.mjs` (also covered by `npm run test:guards`)

## Risk

Low: the change only tightens Goobers contract validation and telemetry metadata; it does not alter gameplay logic or the runtime issue intake flow.
