# Handoff: Fix stale-marker / outdated-thread collision in reconcile.mjs

**Date:** 2026-07-19  
**Session:** fix-ci-incident  
**Branch:** copilot/fix-ci-incident  
**PR:** https://github.com/nalfeo/Crawler/pull/1663

## Systems touched

ci-recovery

## Problem

CI run #29667719202 on `main` (SHA `6b051c0`) failed in the `Format & Labs` job.
One test was failing:

```
not ok 709 - stale-marker thread includes recovery hint in blocker summary
```

The test was introduced in the same commit (#1592) that added auto-posting of
`✅ Addressed` markers for `isOutdated` review threads. The new filter:

```js
candidate.isOutdated && !shouldResolveThread(candidate, headSha, reachableMarkerShas);
```

also matched threads that already had a **stale** trusted marker (a `✅ Addressed`
reply from a trusted author, but pointing to an unreachable/never-pushed SHA).
The auto-post overwrote the stale marker with a new `headSha` marker (with
`authorAssociation: 'OWNER'`), then the resolution pass resolved the thread —
suppressing the stale-marker recovery hint that the next agent needed.

## Fix

Added a guard inside the outdated-marker filter to skip any candidate thread whose
last comment is already a trusted `✅ Addressed` marker (regardless of whether the
SHA is reachable). Threads with an existing stale trusted marker fall through to the
stale-marker detection path below, which correctly surfaces a recovery hint without
auto-resolving.

Changed `.github/scripts/ci-recovery/reconcile.mjs` — the filter body expanded from
a two-condition arrow expression to a multi-branch function that:

1. Returns false for non-outdated threads (unchanged)
2. Returns false when `shouldResolveThread` already succeeds (unchanged)
3. **New:** Returns false when the last comment is a trusted `✅ Addressed` marker

## Verification

- `npm run test:guards`: 1133/1133 pass (was 1132/1133)
- `npm run verify:fast`: all pass, no regressions

## Root cause classification

Logic bug in the new PR #1592 feature: the "auto-resolve outdated threads" loop
did not exclude threads already in the "stale-marker" state. The two code paths
(auto-resolve-outdated and stale-marker-hint) needed to be mutually exclusive.
