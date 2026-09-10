# Session Handoff: Retire health issue automation

## Date

2026-08-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual.

## What changed

- Removed `.github/workflows/test-health.yml`, including its weekly issue filing
  and metrics pull-request automation.
- Kept `.github/workflows/security-review.yml` as a required per-PR security
  gate while removing its schedule, manual dispatch, issue permission, and
  aggregation/issue-filing job.
- Removed both retired loops from repository-level CI incident routing.
- Removed unreachable non-PR branches/report wrappers from Security Review and
  corrected the nightly mutation schedule rationale.
- Updated the CI policy, automation-loop ADR, reviewer guidance, and metrics
  ownership documentation to match the new operating model.
- Added deterministic regression coverage proving the test-health workflow is
  absent and Security Review cannot schedule or file tracking issues.
- Removed a stale visual-review artifact path exposed by the required docs gate.
- Replaced stale ADR links to the retired review-ledger implementation and
  artifacts, and normalized a legacy ADR status heading exposed by the same
  gate.
- Closed all 20 open issues titled `security-review: ...` or `test-health: ...`;
  no matching open generated issues remain.

## Verification

- `npx vitest run tests/unit/retired-health-issue-automation.test.ts tests/unit/detect-change-scope.test.ts tests/unit/ci-workflow-overhead.test.ts tests/unit/pr-workflow-concurrency.test.ts tests/unit/merge-train-promotion-gate.test.ts`
  (115 passed, 7 skipped)
- `npm run verify:fast`
- `npm run docs:check`
- `npm run verify:pr-prereqs`
- Exact GitHub issue queries for both title prefixes returned empty open-issue
  sets after closure.

## Decisions

- Preserved the per-PR Security Review gate because the request targeted noisy
  issue filing, not the deterministic security controls themselves.
- Removed the entire Test Health workflow because it had no PR-gating role and
  all of its triggers fed the retired scheduled health-report loop.

## Unresolved issues

None.
