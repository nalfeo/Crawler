# Handoff: Release Leg Win-Rate Floor Recovery

## Date

2026-08-22

## Persona

DevOps Engineer

## Systems touched

ci-policy, ai-combat-balance

## Apples

2🍎 estimated, 2🍎 actual (🎯 exact).

## Problem

PR #3294 could evaluate report-only leg metrics from legacy sweep-matrix
revisions against the current 90% release floor, filing a current-policy
investigation issue for historical data.

## What changed

- `evaluateLegWinRateFloor()` now collects available legacy metrics for
  diagnostic context but returns a non-breach decision before enforcing the
  current matrix's completeness or win-rate floor.
- The legacy regression coverage now proves that partial and fully populated
  low-win-rate revision-1 baselines remain non-breaching.
- The CLI integration fixture explicitly declares the current sweep revision,
  so its expected release-floor breach remains a current-policy assertion.
- An empty derived report-only-leg set now throws rather than silently passing.

## Validation

- `bash scripts/agent/preflight.sh` passed (including typecheck).
- `npm run test:unit -- tests/unit/baseline-leg-win-rate-floor.test.ts tests/unit/baseline-regression-check.test.ts` passed (23 tests).
- Initial `npm run verify:fast` found a relevant CLI fixture missing current
  sweep provenance; the fixture was corrected and the fast verification was
  rerun before publication.
- Independent review-thread validation by `claude-sonnet-4.6` confirmed the
  revision guard prevents legacy baselines from filing current-policy issues.
