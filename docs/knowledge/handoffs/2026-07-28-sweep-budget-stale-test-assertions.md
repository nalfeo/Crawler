# Handoff: Fix stale sweep-budget test assertions (CI recovery loop unblock)

**Date:** 2026-07-28  
**Session slug:** sweep-budget-stale-test-assertions  
**Apple estimate:** 1🍎  
**Closes:** #2139  
**PR:** fix/sweep-budget-stale-test-assertions  
**Closes:** #2139

## Systems touched

ci-automation, sweep-budget

## Problem

Two tests in `.github/scripts/sweep-budget.test.mjs` permanently failed on `main` after commit
`8889d27f` ("chore(assets): reconcile queued sprite edits (#2081)"). That merge-train commit
silently changed `countLatentBacklog` in `sweep-budget.mjs` to count externally-blocked PRs
(`merge-train-blocked` label) as latent demand instead of excluding them, but did **not** update
the test assertions. This made every PR that diffed against the new `main` fail CI at the
"Lightweight Checks" (`npm run test:guards`) step with:

```
not ok 5 - latent backlog deduplicates merge-train and recovery demand by PR number
  3 !== 2
not ok 6 - latent backlog excludes externally-blocked PRs from the recovery backlog
  1 !== 0
```

PR #2130 ("refactor(agent-os): unify personas and agents") was the first PR to hit this — its
own code was never at fault. The CI recovery automation (2 attempts) could not converge because
the failing tests were in a file the PR never touched, so no automated fix was inferrable from
the diff context alone. The recovery loop escalated to issue #2139.

## Root cause

`8889d27f` modified `sweep-budget.mjs` (lines 91–106) to add an `isExternallyBlocked` path that
contributes blocked PRs to the latent-demand count rather than skipping them entirely. The
corresponding pinning tests (`test 5` and `test 6`) were not updated to reflect the new semantic.

## Fix

Updated `.github/scripts/sweep-budget.test.mjs`:

- **Test 5** ("latent backlog deduplicates…"): corrected comment on PR #3 fixture to describe the
  new "counts once" semantics; changed `assert.equal(…, 2)` → `assert.equal(…, 3)`.
- **Test 6** (previously "excludes externally-blocked PRs from the recovery backlog"): renamed to
  **"counts externally-blocked PRs once as latent demand"**; changed assertion for the `blocked`
  fixture from `assert.equal(…, 0)` → `assert.equal(…, 1)`; updated the leading comment.

`unblocked` assertion in test 6 was already correct (1) and untouched.

## Verification

`node --test .github/scripts/sweep-budget.test.mjs` → 10/10 pass (0 fail).

## What to watch

The PR branch (#2130) already carried the same fix in commit `a77a55f1` — once this fix merges
to `main`, PR #2130's sweep-budget change becomes a no-op diff and CI should green cleanly.
