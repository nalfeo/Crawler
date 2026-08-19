# Merge-train: merge bottom-of-stack PRs via async endpoint instead of rejecting forever

## Systems touched

merge-train, ci-recovery

## Summary

PR #3156 (merged earlier the same day) fixed a crash: the merge-train's
reconciler would 403 and abort the entire reconcile batch whenever a queued
PR was part of a GitHub stacked-PR relationship (classic incident: #3027
stacked under #3033 parked the train for 24h+). That fix rejected ANY
stacked PR at admission with reason `stacked-pr` and treated the underlying
403 as retryable rather than a hard throw.

That fix stopped the crash but was incomplete: it rejects-and-defers a
stacked PR **forever** — there was no code path that ever actually merged a
stacked PR, so it would starve in the queue indefinitely. It also didn't
distinguish stack position: rejecting every stacked PR (including the
bottom-most one) undermines the entire purpose of stacked PRs, which is to
let independent chunks of work merge on their own timeline.

This session implements the corrected design, per GitHub's own
"Merging stacked pull requests" semantics:

- Calling `PUT /pulls/{n}/merge-async` on PR **X** merges every PR in the
  stack from the base up through and including X, atomically. Calling it on
  the **bottom-most** PR in a stack therefore merges **only that PR** —
  there's nothing below it to pull in. GitHub then automatically rebases the
  PR(s) above it directly onto `main`, dissolving the stack: they become
  ordinary, independently-mergeable PRs.
- Calling it on a non-bottom PR would force-merge everything below it too —
  never do this.

## Changes

- `.github/scripts/ci-recovery/state.mjs`: `evaluateAdmission()`'s
  `stacked-pr` rejection now only fires for `stack.position !== 1` (i.e.
  non-bottom). A bottom-of-stack PR (`position === 1`) is now admitted.
- `.github/scripts/merge-train/reconcile-lib.mjs`: added
  `createMergeBottomOfStackPr()`, a new merge function using the async
  submit + poll cycle (`PUT .../merge-async` then poll
  `GET .../merge-async/{uuid}`), mirroring `createMergePullRequest`'s
  never-throws / `{ok, retryable, reason}` contract.
- `.github/scripts/merge-train/reconcile.mjs`: in the main admission loop,
  a PR whose live `stack.position === 1` is routed to
  `mergeBottomOfStackPr` immediately (merged alone, right away) instead of
  being pushed into the classic sequential batch-promotion path — the
  classic `PUT /merge` endpoint still 403s on any stacked PR, bottom
  included, so it must never enter that path.
- Test updates: `pr-lifecycle.test.mjs` now has a non-bottom-stacked-PR
  rejection test and a bottom-of-stack-PR admission test (replacing the old
  blanket-rejection test). `reconcile-promotion.test.mjs` adds 4 new tests
  for `createMergeBottomOfStackPr` (immediate merge, polled merge, failed
  async result, submit failure).

## Verification

- `node --test .github/scripts/merge-train/*.test.mjs .github/scripts/ci-recovery/*.test.mjs`
  → 993 pass, 0 fail (27 skipped, pre-existing Windows subprocess skips
  unrelated to this change).
- `npx eslint` on all changed files → clean (exit 0).
- `bash scripts/agent/verify-fast.sh` → passed.
- This is a scripts/automation-only change (no runtime gameplay code), so no
  visual/headless observation was required.

## Unresolved / next steps

- The live #3027/#3033 stack was never re-checked by this session. If it's
  still open, the next merge-train reconcile run should now pick up #3027
  (bottom, `position 1`) and merge it via the new async path, letting #3033
  fall out of the stack naturally. Worth spot-checking after this PR lands
  and the next scheduled reconcile runs.
- This is a 2🍎 change (small, well-tested, scoped to two files + tests) —
  no review ledger required per `docs/agent-os/policies/review-harness-policy.md`.
