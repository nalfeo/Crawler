# Handoff: sweep-budget countLatentBacklog externally-blocked fix

**Date:** 2026-07-28  
**Session:** nalfeo-crawler-1972 CI recovery investigation  
**PR:** #2142  
**Fixes:** #2140  
**Apple estimate:** 1🍎

## Systems touched

ci-recovery, merge-train

## What was fixed

Two tests in `.github/scripts/sweep-budget.test.mjs` were failing on every CI run, blocking the `Lightweight Checks` gate and preventing PR #1972 (art-only) from merging:

- `latent backlog deduplicates merge-train and recovery demand by PR number` (expected 2, got 3)
- `latent backlog excludes externally-blocked PRs from the recovery backlog` (expected 0, got 1)

## Root cause

`countLatentBacklog()` in `.github/scripts/sweep-budget.mjs` had a third spread that explicitly added externally-blocked PRs (those with `merge-train-blocked`, `merge-train-validation-failed`, `human-approval-required`, `ci-conflict-order-wait`, or `ci-conflict-escalation` labels) to the latent backlog count:

```js
// WRONG: the comment said they "still represent latent demand" but
// tests explicitly assert they should be excluded
...(pullRequests || [])
  .filter(
    (pr) =>
      pr.state === 'open' &&
      !pr.draft &&
      pr.base?.ref === 'main' &&
      pr.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
      !(pr.labels || []).some((label) => label.name === 'ci-recovery-opt-out') &&
      isExternallyBlocked(pr),
  )
  .map((pr) => pr.number),
```

These PRs should NOT be counted because:
1. They can't be advanced by CI recovery
2. Counting them inflates the backlog, causing unnecessary recovery throttling
3. The authoritative tests (written to pin the exclusion) explicitly say 0 for blocked PRs

## Fix

Removed the erroneous third spread and unused `isExternallyBlocked` import from `countLatentBacklog`. The function now only unions:
1. `queueEntries()` — PRs in the merge-train queue
2. `recoveryBacklogEntries()` — PRs eligible for CI recovery (already excludes externally-blocked)

## Why recovery automation failed to self-heal

The 2 test failures were in the CI automation scripts themselves (not game code). The CI recovery automation dispatches against open PRs that need their CI fixed — but it cannot fix test failures in its own source files without a human-directed or agent-directed implementation session.

## Verification

All 10 tests in `sweep-budget.test.mjs` pass after the fix (was 8/10 before).
