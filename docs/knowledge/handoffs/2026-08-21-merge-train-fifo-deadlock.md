# Merge train FIFO deadlock on un-advanceable head-of-line PR

**Date:** 2026-08-21
**Systems touched:** merge-train, ci-recovery

## Symptom

The merge train ran every ~30 minutes, reported `success` on every run, and
merged nothing for hours. Three PRs carried the `merge-train` label; two of them
(#3216, #3218) were fully green, mergeable, and had zero unresolved review
threads. Nothing moved.

The entire reconcile step produced only two lines of signal:

```
update-branch pr=#3208 same-repo-restricted-branch (403): leaving queued, dispatching recovery
No admitted PR is ready for candidate construction
```

## Root cause

`reconcile.mjs` walks the queued PRs in FIFO order. When an entry is `behind`,
it calls the update-branch API and then unconditionally `break`s out of the
admission loop, so newer PRs cannot leapfrog a PR the train is advancing.

The `break` was skipped only for the **fork-dequeue** case (`dequeuedFork`),
where the entry is removed from the queue entirely.

The **same-repo restricted-branch 403** path (added to fix the #3027 label-churn
livelock) correctly leaves the PR queued — but then fell through to the same
unconditional `break`. That combination is a permanent deadlock:

- the train can never advance the head-of-line PR (403 on every pass), and
- the head-of-line PR is never dequeued (by design, to avoid label churn), so
- the `break` fires on every pass, and every later queued PR starves forever.

`#3208` was the head entry. Its branch is `nalfeo-repair-asset-queue`, which the
merge-train app token cannot push to, so update-branch 403'd on every cycle.
`#3216` and `#3218` were behind it in FIFO order and never got evaluated at all.

The workflow exits 0 on this path, so run status showed `success` throughout and
the deadlock was invisible in the Actions UI.

## Fix

Renamed `dequeuedFork` to `yieldFifoLine` and set it in the same-repo 403 branch
as well. The gate is now `if (!yieldFifoLine) break;`.

The invariant is: **FIFO holds the line for a PR the train is actively
advancing, never for one the train provably cannot advance on any pass.** Both
un-advanceable outcomes (fork dequeue, same-repo restricted branch) release the
line so later entries are still evaluated in the same cycle.

The same-repo PR still stays queued and still dispatches recovery — the #3027
label-churn fix is preserved untouched.

## Regression coverage

Two source-assertion tests in `reconcile.test.mjs`:

- the same-repo 403 branch must set `yieldFifoLine`
- the FIFO break must be gated on `yieldFifoLine`, and `dequeuedFork` must be
  gone entirely (so the fork-only gate cannot be reintroduced)

`node --test .github/scripts/merge-train/reconcile.test.mjs` → 77/77 pass.

## Follow-up (not done here)

Agent-authored PRs still open with auto-merge unarmed (`autoMergeRequest: null`
on 7/7 open PRs, observed three days running). That is a separate leak in the
PR-publish path and needs its own change.
