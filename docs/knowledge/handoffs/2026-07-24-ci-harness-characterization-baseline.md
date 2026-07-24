# Handoff: CI harness characterization baseline

## Date

2026-07-24

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 3🍎.

## Summary

Added a deterministic, offline characterization baseline for the CI harness redesign scope:

- Added `.github/scripts/ci-recovery/characterization/reconcile-decision-fixtures.json` with exactly 34 reconcile decision-point fixtures (`R01`–`R34`), each tagged to deadlock classes `D1`–`D10` and mapped to concrete coverage tests.
- Added D3-specific review-wake gap fixtures (via `shouldRequestReview`) so the baseline explicitly captures the current review-vs-repair wake behavior.
- Added characterization tests for all three harness machines:
  - `.github/scripts/ci-recovery/characterization.test.mjs`
  - `.github/scripts/merge-train/characterization.test.mjs`
  - `.github/scripts/ci-conflict-coordinator/characterization.test.mjs`
- Added fixture catalogs for merge-train and conflict coordinator:
  - `.github/scripts/merge-train/characterization/verdict-fixtures.json`
  - `.github/scripts/ci-conflict-coordinator/characterization/verdict-fixtures.json`
- Added absorbed regression guard from superseded PR #1782:
  - `tests/unit/ci-knobs-guard.test.ts`
- Kept existing absorbed coverage for PRs #1797/#1833/#1813/#1791 and recorded them in fixture inventory.

## Files touched

- `.github/scripts/ci-recovery/characterization/README.md`
- `.github/scripts/ci-recovery/characterization/reconcile-decision-fixtures.json`
- `.github/scripts/ci-recovery/characterization.test.mjs`
- `.github/scripts/merge-train/characterization/verdict-fixtures.json`
- `.github/scripts/merge-train/characterization.test.mjs`
- `.github/scripts/ci-conflict-coordinator/characterization/verdict-fixtures.json`
- `.github/scripts/ci-conflict-coordinator/characterization.test.mjs`
- `tests/unit/ci-knobs-guard.test.ts`
- `docs/knowledge/review-ledgers/2026-07-24-ci-harness-characterization-baseline.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-24-ci-harness-characterization-baseline.md`

## Verification

- `node --test .github/scripts/ci-recovery/characterization.test.mjs .github/scripts/merge-train/characterization.test.mjs .github/scripts/ci-conflict-coordinator/characterization.test.mjs` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-24-ci-harness-characterization-baseline.review-ledger.json` ✅
- `npm run verify:fast` ❌ (environment dependency issue: local `node_modules` unavailable; `npx` fallback failed because required packages are not installed and network fetch to `ms-feed-12.pkgs.visualstudio.com` failed)
- `npm run verify:pr-prereqs` pending final rerun after this handoff file commit

## Unresolved issues

- Full `verify:fast` / Vitest-based unit checks could not run in this environment due to dependency-install/network restrictions.

## Recommended next steps

1. Re-run `npm run verify:pr-prereqs` now that handoff + review ledger are committed.
2. In a network-enabled environment with dependencies installed, run:
   - `npm run test:unit -- tests/unit/ci-knobs-guard.test.ts tests/unit/deploy-workflow-gating.test.ts`
   - `npm run verify:fast`
3. Keep this fixture baseline frozen for upcoming harness-refactor PR diffs.
