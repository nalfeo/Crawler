# Fix CI Recovery Loop Failure on PR #1923

**Date:** 2026-07-25  
**Slug:** fix-ci-recovery-loop-1923

## Systems touched

ci-recovery

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Summary

The CI recovery automation failed to converge on PR #1923 after 2 attempts. PR #1923 introduced a data-driven dispatch table (`dispatch-table.mjs`) to fix the D5 deadlock class in the CI recovery orchestrator. Investigation revealed 4 unresolved reviewer thread bugs and 1 CI test failure.

## Root cause analysis

1. **Thread 1 (owner-blind exits):** Two reported owner-blind early-exit paths in `reconcile.mjs` bypassed Phase A's R05 stale-automation release:
   - `ci-recovery-opt-out` exit at line ~1170 (before Phase A at line ~1248) — fires regardless of who holds the label
   - `train-conflict-predecessor-pending` exit at line ~1788 (after Phase A) — fires regardless of ownership when a merge-train predecessor is queued
   Both exits could strand the ci-owner fence indefinitely on PRs with a stale automation lock.

2. **Thread 2 (dead code):** `buildTerminalDispatchTable()` and `selectTerminalAction()` in `dispatch-table.mjs` were a dead parallel implementation — `reconcile.mjs` only imported `DISPATCH_ACTION` and `selectEarlyAction`. The real terminal cascade remains inline in `reconcile.mjs` at lines 2145–2426.

3. **Thread 3 (missing invariant coverage):** `EARLY_OWNER_BLIND_SKIP_ACTIONS` only contained R06/R07, omitting R09 (`WAIT_CONFLICT_REBASE_PENDING`) and R10 (`WAIT_CONFLICT_REBASE_BACKOFF`). The D5 structural invariant check (`assertEarlyTableInvariant`) would not catch a future RELEASE row placed after R09/R10.

4. **Thread 4 (missing test):** No reconcile-level test verified that the conflict episode marker is posted before the R08 conflict-only rebase dispatch exits.

5. **CI test failure:** PR #1923 accidentally removed:
   - Loop incident filing from the R05 case (mirroring main's exhausted conflict-reclaim path)
   - Validation-recovery rebase path for non-conflicted `merge-train-validation-failed` PRs
   - 5 corresponding regression tests

## Files touched

- `.github/scripts/ci-recovery/dispatch-table.mjs` — removed dead `buildTerminalDispatchTable`/`selectTerminalAction`; added R09/R10 to `EARLY_OWNER_BLIND_SKIP_ACTIONS`
- `.github/scripts/ci-recovery/dispatch-table.test.mjs` — removed terminal table tests; added 2 new invariant tests for R09/R10
- `.github/scripts/ci-recovery/reconcile.mjs` — added pre-exit stale release guards before `ci-recovery-opt-out` and `train-conflict-predecessor-pending` exits; restored loop incident filing in R05 case; restored validation-recovery rebase path
- `.github/scripts/ci-recovery/reconcile.test.mjs` — restored 5 removed regression tests; added conflict-episode ordering coverage, the full conflict-resolved second pass, stale `ci-recovery-opt-out` / predecessor-pending release regressions, and validation-rebase backoff coverage
- `.github/scripts/ci-recovery/review-wake-bridge.mjs` — (carried from PR #1923) adds `dispatch-table.mjs` to `PROTECTED_WORKFLOW_PATHS`
- `.github/scripts/ci-recovery/review-wake-bridge.test.mjs` — adds `dispatch-table.mjs` to test's `protectedPaths` list
- `docs/knowledge/review-ledgers/2026-07-25-fix-ci-recovery-loop-1923.review-ledger.json` — corrected the branch to 3🍎 and recorded the required plan/code-review stages
- `docs/knowledge/metrics/apples/2026-07-25-fix-ci-recovery-loop-1923.json` — apple calibration record for the 3🍎 session

## Verification

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` ✅ after the follow-up coverage additions
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-25-fix-ci-recovery-loop-1923.review-ledger.json`
- `npm run verify:pr-prereqs`
- `npm run verify:fast` ❌ sandbox dependency install is incomplete, and fresh install is blocked by DNS failures to `ms-feed-2.pkgs.visualstudio.com`

## Review harness

- Plan review (`gpt-5.4`): 3 concerns resolved; `plan_divergence=minor`.
  - Narrowed the stale-owner claim to the two reported owner-blind exits instead of every early skip.
  - Added the missing validation-rebase `auto-rebase-failure` backoff regression.
  - Kept the invariant scoped to Phase A while adding explicit reconcile-level regressions for the inline owner-blind exits.
- Code review (`claude-sonnet-4.6`): round 1 clean, no validated findings.

## Recommended next steps

- Watch CI on the opened PR; if green, arm squash auto-merge
- Reply to the reviewer threads on PR #1923 with `✅ Addressed in <sha>: ...` markers from the repaired head SHA

## Unresolved issues

No known code defects remain in this recovery branch. The only remaining local limitation is environment-side: full `npm run verify:fast` cannot complete in this sandbox until dependency resolution to the Microsoft npm mirror works again.
