# Handoff: Fix stale sweep-budget test expectation after externally-blocked PR exclusion

## Date
2026-07-27

## Session slug
sweep-budget-test-stale-expectation

## Summary
Fixed a failing CI test in `.github/scripts/sweep-budget.test.mjs`. The test "latent backlog deduplicates merge-train and recovery demand by PR number" expected `countLatentBacklog(...)` to return `3` but the function returned `2` after commit `492bb4be` added `isExternallyBlocked()` to `eligibleTrainRecoveryPulls()`.

## Root cause
Commit `492bb4be` ("fix(ci-recovery): unstarve the repair window so the merge train can refill", 2026-07-27) introduced `isExternallyBlocked()` as a critical fix to prevent externally-blocked PRs (`merge-train-blocked`, `ci-conflict-order-wait`, `human-approval-required`, etc.) from consuming bounded `REPAIR_WINDOW_SIZE` sweep slots with guaranteed no-op dispatches.

The test was authored in `f7aafa43` ("feat(ci): make broad sweep capacity queue-aware") before this fix. It included a PR with `merge-train-blocked` label in its test population and expected the backlog count to be `3`. After `492bb4be`, `merge-train-blocked` PRs are correctly excluded (reconcile skips them unconditionally, so CI Recovery can never advance them), making the correct count `2`.

## Fix
Updated the assertion in `sweep-budget.test.mjs` line 68 from `3` to `2`, and added a brief inline comment explaining why `merge-train-blocked` is excluded.

## Verification
- `node --test .github/scripts/sweep-budget.test.mjs` → 9 tests / 9 pass / 0 fail ✅

## Systems touched
ci-recovery, merge-train

## Apple estimate
1🍎
