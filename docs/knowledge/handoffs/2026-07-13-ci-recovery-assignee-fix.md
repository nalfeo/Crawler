# CI Recovery: Remove Copilot-Assignee Short-Circuit

**Date:** 2026-07-13  
**Branch:** fix-recovery-lease-ownership-gate  
**Apple estimate:** 1🍎

## Summary

Removed the `existing-copilot-assignment` early-exit guard from `reconcile.mjs` that was incorrectly suppressing CI recovery dispatch when Copilot was assigned to a PR but there was no active lease or state marker. Only lease/state ownership (owner label + state comment) should suppress recovery. Added a regression test proving the correct behavior.

## Systems touched

ci-policy

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs` — removed 3-line guard (lines 233-236)
- `.github/scripts/ci-recovery/reconcile.test.mjs` — added regression test
- `docs/knowledge/review-ledgers/2026-07-13-ci-recovery-assignee-fix.review-ledger.json` — review ledger

## Verification run

- `bash scripts/agent/preflight.sh` ✅
- `npm run verify:fast` ✅
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`: before=2 pass/6 fail; after=3 pass/6 fail (same pre-existing Windows `UV_HANDLE_CLOSING` failures, +1 new green regression test)

## Unresolved issues

- The 6 pre-existing Windows test failures (`UV_HANDLE_CLOSING` in `src\win\async.c`) are infra issues unrelated to this change. They pass in CI (Linux).

## Recommended next steps

- Verify CI passes on the PR
- Confirm recovery now dispatches correctly for Copilot-assigned PRs with no lease
