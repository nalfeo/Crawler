# Handoff: In-game reported-issue label

## Systems touched

devtools, ci-policy

## Apples

Estimated: 1. Actual: 1.

## Summary

- Explicit in-game issue filings now receive both `telemetry` and
  `reported-issue`.
- Survey-only filings remain `telemetry`-only, preserving the anonymous-ingest
  quarantine that prevents automatic Copilot intake.
- The `reported-issue` repository label identifies player-authored reports
  without granting any trusted automation capability.

## Verification

- `npm exec vitest run tests/unit/dev-build-ingest-handler.test.ts tests/unit/dev-ingest-workflow-parity.test.ts`
- `npm run typecheck`
- `npm run verify:fast`
