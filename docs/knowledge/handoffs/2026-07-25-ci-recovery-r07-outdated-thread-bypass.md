# CI Recovery: R07/R06 pre-exit outdated-thread bypass fix

**Date:** 2026-07-25  
**Session:** ci-recovery-r07-outdated-thread-bypass  
**Apple estimate:** 🍎 (1 — small script fix + regression tests, no gameplay code)  
**Closes:** #2047
**PR:** #2058

## Systems touched

ci-recovery

## Problem

The CI recovery reconciler has an early-exit table (dispatch-table.mjs) that
fires before the main flow fetches review data. Two of those exits — **R06**
(merge-train-owned) and **R07** (ci-conflict-order-wait) — would call
`process.exit(0)` without ever calling `listReviewThreads` or running the
auto-outdated-marker / thread-resolution passes (lines 1555–1623 in the old
file).

Concretely, on PR #2016:

1. A review thread (`PRRT_kwDOSvo2Ms6TwYIN`) became `is_outdated: true` after
   @copilot pushed new commits.
2. The conflict coordinator labelled the PR `ci-conflict-order-wait` (R07).
3. Every subsequent sweep emitted `skip pr=#2016 reason=ci-conflict-order-wait`
   and exited before fetching review data — so the outdated thread was never
   resolved.
4. The loop-incident (issue #2047) was escalated to a human.

## Root cause

`listReviewThreads` was called at the **top level** of the script body (old line
1455), after the `{}` early-exit block (old lines 1269–1453). R06/R07 handlers
inside the block called `process.exit(0)` before execution ever reached line
1455, so the auto-outdated-marker and thread-resolution passes (old lines
1555–1623) were never reached.

## Fix

Added a new `resolveOutdatedThreadsBeforeEarlyExit()` async function
(`reconcile.mjs`) that:

1. Lazily fetches review threads via `listReviewThreads`.
2. Runs the auto-outdated-marker pass (same logic as the main flow, using an
   empty `reachableMarkerShas` set since the SHA lineage check is unreachable
   from the early-exit path).
3. Runs the thread-resolution pass.
4. Is best-effort: all fetch and mutation errors are caught and logged so the
   early exit always proceeds cleanly.

The function is called in R06 and R07 handlers **before** `process.exit(0)`.

## Files changed

- `.github/scripts/ci-recovery/reconcile.mjs` — adds
  `resolveOutdatedThreadsBeforeEarlyExit()` and calls it from R06/R07 handlers.
- `.github/scripts/ci-recovery/reconcile.test.mjs` — adds 3 regression tests:
  - `dry-run: R07 ci-conflict-order-wait exit still runs outdated-thread cleanup`
  - `live: R07 ci-conflict-order-wait exit posts outdated-marker and resolves thread before skipping`
  - `dry-run: R06 merge-train-owned exit still runs outdated-thread cleanup`

## Testing

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` → 139/139 pass
- `npm run verify:fast` → exit 0

## Alternatives considered

- **Refactoring**: Moving `listReviewThreads` before the early table — rejected
  because it adds latency to every sweep (even PRs with no review threads), and
  the early table is designed to be cheap.
- **Splitting into two scripts**: Too invasive for a 1-apple fix.

## Notes

The helper uses `emptyReachable = new Set()` (no SHA lineage check) because
it cannot reach the compare API call from the early-exit path. This is
conservative — threads with stale-SHA markers remain as blockers rather than
being incorrectly resolved — while still handling the most common case
(outdated-unresolved threads with no marker at all, which account for most
loop-incident-causing blockers).
