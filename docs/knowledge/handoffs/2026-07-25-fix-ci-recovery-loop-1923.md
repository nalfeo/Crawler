# Fix CI Recovery Loop Failure on PR #1923

**Date:** 2026-07-25  
**Slug:** fix-ci-recovery-loop-1923

## Systems touched

ci-recovery

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Summary

The CI recovery automation failed to converge on PR #1923 after 2 attempts. Investigation found two root causes:
1. The copilot recovery job failed transiently because `claude-sonnet-4.5` was unavailable.
2. PR #1923 had 4 unresolved reviewer threads identifying real bugs in its dispatch-table approach.

The main branch already contains the correct code for three of the four review concerns (R09/R10 in owner-blind set, pre-exit stale-lock release guards, conflict-episode marker test). The fourth concern — that `buildTerminalDispatchTable`/`selectTerminalAction` functions existed only in the PR's dead parallel implementation and lacked tests — is fixed here by adding these functions to main's `dispatch-table.mjs` with full unit tests.

## Root cause analysis

**Why recovery made no progress:**
- The copilot recovery job (89711006523) crashed immediately: `Model "claude-sonnet-4.5" is not available`.
- This is a transient model-unavailability failure, not a code defect in the recovery pipeline.
- Separately, PR #1923's Lightweight Checks job failed with 1 failing test (somewhere in the 200+ files that PR changes).

**Review thread findings vs. main branch:**
1. **Thread 1 (R05 doesn't protect opt-out/predecessor exits):** Main already has pre-exit stale-automation release guards at lines ~1168 and ~1765 of `reconcile.mjs`. The PR removed these guards; main preserves them.
2. **Thread 2 (terminal table unwired):** PR #1923 added `buildTerminalDispatchTable`/`selectTerminalAction` to `dispatch-table.mjs` but did not import/use them in `reconcile.mjs`, leaving them as dead code. Main did not have these functions at all. This PR adds them properly with documentation and full unit tests (10 new tests).
3. **Thread 3 (R09/R10 missing from invariant):** Main already includes `WAIT_CONFLICT_REBASE_PENDING` and `WAIT_CONFLICT_REBASE_BACKOFF` in `EARLY_OWNER_BLIND_SKIP_ACTIONS`. The PR removed them; main preserves them, with 2 tests that enforce the invariant for these cases.
4. **Thread 4 (missing conflict-episode test):** Main already has the 2-pass conflict-episode marker test at line 11679 of `reconcile.test.mjs`. The PR removed it; main preserves it.

## Files touched

- `.github/scripts/ci-recovery/dispatch-table.mjs` — Added `buildTerminalDispatchTable()` and `selectTerminalAction()` with documentation marking wiring as a follow-up TODO. Updated scope comment to reflect both tables.
- `.github/scripts/ci-recovery/dispatch-table.test.mjs` — Added 10 new unit tests for `buildTerminalDispatchTable` and `selectTerminalAction` covering all 8 terminal table rows.

## Verification

- `node --test .github/scripts/ci-recovery/dispatch-table.test.mjs` ✅ (32 tests, 0 failures)
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` ✅ (136 tests, 0 failures)
- `npm run verify:fast` ✅ (1719 tests, 0 failures)

## Recommended next steps

- Watch CI on the opened PR; if green, arm squash auto-merge
- Reply to the reviewer threads on PR #1923 explaining the approach
- Follow up to wire `selectTerminalAction` into `reconcile.mjs` to replace the inline terminal cascade (deferred by this PR per the review comment's "narrow the scope" option)

## Unresolved issues

- PR #1923 itself still needs its CI fixed (1 failing test) and review threads resolved before it can merge. That is separate work.
- The `selectTerminalAction` wiring into `reconcile.mjs` is explicitly deferred.
