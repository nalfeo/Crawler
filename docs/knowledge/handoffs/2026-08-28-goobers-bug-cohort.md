# Handoff: Goobers bug-report cohort

## Systems touched

devtools, ci-policy

## Apples

Estimated: 2. Actual: 2.

## Summary

- Explicit in-game bug reports now receive `goobers:approved` alongside
  `telemetry` for a stable hash-based 50/50 experiment cohort.
- Survey-only issue filing remains telemetry-only.
- Cohort assignment is derived from the persisted run ID, so retries preserve
  the same routing decision.

## Verification

- `npm exec vitest run tests/unit/dev-build-ingest-handler.test.ts tests/unit/dev-ingest-workflow-parity.test.ts`
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`
