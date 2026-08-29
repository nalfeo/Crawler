# Handoff: Goobers bug-report cohort

## Systems touched

devtools, ci-policy

## Apples

Estimated: 2. Actual: 2.

## Summary

- All in-game issue filing remains telemetry-only. Public anonymous ingest must
  not assign the trusted `goobers:approved` label, which starts repository-write
  automation.
- Both explicit bug reports and survey-only issue filing have handler-level
  label coverage.

## Verification

- `npm exec vitest run tests/unit/dev-build-ingest-handler.test.ts tests/unit/dev-ingest-workflow-parity.test.ts`
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`
