# 2026-07-24 CI Recovery: Merge-Train-Validation Auto-Rebase Fix

## Summary

Fixed a deterministic CI recovery loop where PRs labeled `merge-train-validation-failed`
+ `merge-train-blocked` (but without a merge conflict) would exhaust two Copilot dispatch
attempts without making any progress, causing the automation to mark them
`stale-automation-exhausted` and file an investigation issue.

## Root cause

When the merge train bisects a failing candidate and identifies a PR as the "first failing
addition", it adds `merge-train-blocked` + `merge-train-validation-failed` labels and
removes the `merge-train` queue label. The CI recovery reconcile then creates a
`merge-train-validation` blocker and dispatches Copilot to "fix" it.

But this blocker has **no code fix**. The label is cleared only when:
- The PR head moves (triggering `headMovedSinceState`), OR  
- A `:synchronize` event fires on the PR while `trainBlocked` is true

Neither condition is satisfied by a Copilot dispatch that finds nothing wrong with the
code — so the automation retried twice, hit `automationStallAction` returning `'release'`,
and filed issue #1896.

## Fix

Added a **validation-recovery auto-rebase dispatch path** in `reconcile.mjs`, mirroring
the existing conflict-rebase path:

- When `mergeTrainEnabled && validationFailed && !hasMergeConflict` and the rebase
  attempts aren't exhausted, dispatch `auto-rebase-prs.yml` with
  `trigger=ci-recovery-validation`.
- The rebase creates a new head commit that fires a `:synchronize` event.
- The next reconcile sees `headMovedSinceState = true` + `trigger.endsWith(':synchronize')`,
  clears both train labels, and re-admits the PR to the merge train.
- The same exponential backoff (60s/120s/240s) and `REBASE_FAILURE_MAX_ATTEMPTS` bounds
  that govern the conflict-rebase path apply here too.
- After exhausting bounded retries, falls through to the existing `merge-train-validation`
  blocker + Copilot dispatch (last-resort escalation).

## Files changed

- `.github/scripts/ci-recovery/reconcile.mjs` — new validation-rebase dispatch block
  between the `hasMergeConflict` fallthrough blocker and the `validationFailed` blocker
  (lines ~1749–1840)
- `.github/scripts/ci-recovery/reconcile.test.mjs` — three regression tests:
  1. Happy path: dispatches validation-recovery rebase instead of Copilot
  2. Pending wait: waits when a rebase is still in flight for the same head
  3. Exhaustion fallthrough: escalates to Copilot after `REBASE_FAILURE_MAX_ATTEMPTS`

## Verification

All 129 reconcile tests pass (`node --test .github/scripts/ci-recovery/reconcile.test.mjs`).

## Systems touched

ci-recovery

## Apple estimate

1🍎 — tooling-only, surgical addition to a single script, capped at 3🍎 per policy
