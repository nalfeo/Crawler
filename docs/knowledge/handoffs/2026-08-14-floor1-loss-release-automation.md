# Floor 1 loss release automation

**Date:** 2026-08-14
**Apples:** 2🍎 (declared 2🍎)

## Systems touched

ci-policy, release-baseline

## Summary

Changed release baseline handling so every Floor 1 loss files or reopens the
idempotent release-sweep issue. The release target is 100% Floor 1 success, so
this no longer depends on a historical win-rate delta or a prior baseline.

Added a complete-floor coverage table to the released-PR baseline comment. It
shows the Floor 1 blocking leg plus the Floor 2 and chained Floor 1-to-Floor 2
report-only legs, each with its win rate and sample count.

## Verification

- Focused baseline-regression and baseline-comment unit tests: 15 passed.
- `npm run typecheck` passed.
- `npm run verify:fast` passed.
