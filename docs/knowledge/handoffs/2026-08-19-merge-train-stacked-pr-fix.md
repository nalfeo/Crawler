# 2026-08-19 — Merge-train stacked-PR crash fix

## Summary

`merge-train` (a required status check on `main`) had failed 10+ times in a
row since ~10:12 UTC, blocking every queued PR (~15 PRs, including a night's
worth of bug-fix PRs) because they all showed `mergeStateStatus=BLOCKED`.

Root cause: PR #3027 was queued for the merge train while being part of a
GitHub **stacked pull request** relationship (PR #3033 was stacked on top of
its head branch). GitHub's classic synchronous merge endpoint
(`PUT /pulls/{n}/merge`, used by the merge-train bot) always 403s for any PR
that's part of a stack: `Merging stacked PRs via this endpoint is not
supported. Use the asynchronous merge endpoint instead.` That 403 fell into
the existing generic non-retryable-403 path, threw `MergeTrainPromotionError`,
and crashed the entire reconcile batch — so no PR merged and the required
`merge-train` check stayed red for every PR behind #3027 in the queue.

## Fix

Two-layer fix, landed on branch `nalfeo-merge-train-reject-stacked-prs`:

1. **Root-cause / admission-level**: `evaluateAdmission()` in
   `.github/scripts/ci-recovery/state.mjs` (the canonical admission predicate
   shared by merge-train and the CI-recovery lifecycle FSM) now rejects any PR
   with a non-null `.stack` object, reason `stacked-pr`. `reconcile.mjs`'s
   `eligible()` now passes `pr.stack ?? null` into `prFacts` (already present
   on the list-pulls response — no extra API call). A stacked PR is now never
   treated as merge-train eligible; it's deferred until the stack resolves.
2. **Defense in depth**: `createMergePullRequest()` in
   `.github/scripts/merge-train/reconcile-lib.mjs` now detects the specific
   "stacked PR" 403 message and returns `{ retryable: true }` instead of
   throwing, so a race-window slip-through no longer crashes/aborts the whole
   promotion batch.

## Immediate unblock (live repo)

Manually resolved the live #3027/#3033 stack by merging PR #3033 (the top of
the 2-entry stack) via GitHub's async merge endpoint directly:

```
gh api -X PUT repos/nalfeo/Crawler/pulls/3033/merge-async -f merge_method=squash -f merge_action=default
```

This is the only endpoint that supports merging a stack (`PUT
/pulls/{n}/merge`, `gh pr merge`, and `gh pr merge --admin` all reject stacked
PRs even for an admin/bypass actor — GitHub enforces "use the async endpoint"
regardless of permission level). This dissolves the stack, which should let
`merge-train` resume processing the ~15-PR backlog.

## Files touched

- `.github/scripts/ci-recovery/state.mjs`
- `.github/scripts/merge-train/reconcile.mjs`
- `.github/scripts/merge-train/reconcile-lib.mjs`
- `.github/scripts/ci-recovery/pr-lifecycle.test.mjs` (+2 tests)
- `.github/scripts/merge-train/reconcile-promotion.test.mjs` (+1 test)

## Verification

- `node --test .github/scripts/merge-train/*.test.mjs .github/scripts/ci-recovery/*.test.mjs` → 982 passed, 0 failed, 33 skipped.
- `npx eslint` clean on all 5 changed files.

## Systems touched

ci-cd, merge-train

## Unresolved issues / recommended next steps

- Confirm the merge-train workflow's next scheduled/triggered run succeeds and
  the ~15 previously-blocked PRs transition out of `BLOCKED`.
- Consider whether the merge-train queue-builder should also actively detect
  and skip _any_ PR currently in a stack when constructing the candidate batch
  (rather than relying solely on `evaluateAdmission` at eligibility time), in
  case admission is checked once but the PR becomes stacked mid-batch — the
  defense-in-depth retryable-403 handling covers this today, but a proactive
  skip would avoid even attempting the doomed merge call.
