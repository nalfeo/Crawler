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
- ESLint and Prettier, scoped to the changed files only
- `npm run verify:pr-prereqs`
- `npm run verify:fast` did **not** run: this Windows host resolves `bash` to
  WSL with no installed distribution, so the shell wrapper cannot execute. The
  checks above were run directly instead; the full fast gate is covered by CI.
