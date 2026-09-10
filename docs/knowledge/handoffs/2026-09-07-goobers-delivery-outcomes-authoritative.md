# Goobers delivery outcomes authoritative

## Systems touched

goobers-workflow, ci-reporting

## Outcome

Implemented the issue #4441 reporting correction. The Goobers result reporter now
derives a delivery outcome independently from the Actions conclusion:
`pr-opened`, `issue-completed`, `blocked`, `timeout`, `no-work`, or `aborted`.
Only PR delivery and explicit existing-work completion are success outcomes.
Failed PR-open gates, unresolved PR state, invalid no-work, timeouts, and
aborts retain a failure/blocking code and point to the uploaded journal artifact.

Terminal issue comments now contain only the delivery outcome, Actions
conclusion, failure code, terminal stage, elapsed time, artifact link, and an
opened PR link when available. Journal messages and PR-resolution diagnostics
remain in the run artifact.

## Verification

- `npx vitest run tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts tests/unit/goobers-contracts.test.ts`
- `node .github/scripts/validate-goobers-contracts.mjs`
- `bash scripts/agent/verify-fast.sh`

## Risk

Low: this changes only Goobers workflow terminal classification and reporting;
the existing claim cleanup and PR-open remediation paths remain intact.
