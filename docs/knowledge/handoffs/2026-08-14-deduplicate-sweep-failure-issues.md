# Deduplicate sweep failure issues

**Date:** 2026-08-14
**Apples:** 2🍎 (declared 2🍎, actual 2🍎)

## Systems touched

ci-policy, release-baseline

## Summary

Release-sweep loss filing now derives a stable signature from each persisted Floor 1 failure's seed, weapon, and sweep configuration. The filer searches open automation issues for that signature, updates the matching issue when the failure recurs on a new release, and creates an issue only for unseen signatures. Closed issues do not suppress reporting.

## Files touched

- `.github/scripts/baseline-regression-issue.mjs`
- `.github/scripts/baseline-regression-issue.test.mjs`
- `scripts/agent/perf/baseline-regression-check.ts`
- `tests/unit/baseline-regression-check.test.ts`

## Verification

- `node --test .github/scripts/baseline-regression-issue.test.mjs`
- `npm run test:unit -- tests/unit/baseline-regression-check.test.ts tests/unit/baseline-regression-workflow.test.ts`
- `npm run typecheck`
- `npm run verify:fast`

## Unresolved issues

None known.
