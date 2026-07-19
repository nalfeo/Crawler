# Handoff: CI Recovery Stale-Marker Auto-Resolution Fix

**Date:** 2026-07-19  
**Session slug:** ci-recovery-stale-marker-fix  
**Branch:** copilot/fix-ci-recovery-loop-again  
**PR:** Closes #1664 (CI recovery loop incident for PR #1638)  
**Apple estimate:** 1🍎

## Systems touched

ci-recovery

## Problem

The CI recovery reconciler (`reconcile.mjs`) had a defect in the "mutation sequence" for
outdated review threads that carry a stale `✅ Addressed` marker:

1. A recovery agent replied with `✅ Addressed in <sha>` but that commit was never pushed to
   GitHub (or was squash-rebased away).
2. The compare API returns 404 → SHA is classified as `definitivelyUnreachable`.
3. `shouldResolveThread()` returns `false` (stale SHA ≠ current head).
4. **BUG**: The outdated-marker loop filter (`isOutdated && !shouldResolveThread`)
   included the thread because `shouldResolveThread` was `false`.
5. The reconciler injected a NEW auto-marker (`✅ Addressed in ${headSha}: thread outdated`)
   and then resolved the thread in the same pass.
6. This masked the real issue — the original fix commit was never deployed — instead of
   surfacing it via the stale-marker hint in the task comment.

The bug was confirmed by the failing test:

```
test('stale-marker thread includes recovery hint in blocker summary')
```

On `main`, that test failed with:

```
posted outdated-marker thread=PRRT_stale_marker_thread
resolved thread=PRRT_stale_marker_thread
```

This was also the root cause of the CI recovery loop incident for PR #1638: the reconciler
was not correctly routing stale-marker threads, and recovery agents received task comments
without the stale-marker hint needed to identify the real problem.

## Fix

Added a `threadsWithStaleMarker` guard set before the outdated-marker loop in
`.github/scripts/ci-recovery/reconcile.mjs`:

```javascript
const threadsWithStaleMarker = new Set(
  unresolvedThreads
    .filter((thread) => {
      const comments = thread.comments?.nodes ?? [];
      const last = comments[comments.length - 1];
      if (!last) return false;
      const markerSha = extractAddressedMarkerSha(last.body);
      if (!markerSha || headSha.startsWith(markerSha)) return false;
      return definitivelyUnreachableMarkerShas.has(markerSha);
    })
    .map((thread) => thread.id),
);
```

The outdated-marker loop now excludes threads in this set:

```javascript
candidate.isOutdated &&
!shouldResolveThread(candidate, headSha, reachableMarkerShas) &&
!threadsWithStaleMarker.has(candidate.id),  // ← NEW
```

## Tests

- All 91 existing reconcile tests pass.
- Strengthened `'stale-marker thread includes recovery hint'` to also assert:
  ```javascript
  assert.doesNotMatch(
    stdout,
    /posted outdated-marker thread=PRRT_stale_marker_thread/,
    'must not post an auto-marker for a stale-marker thread (would mask the real issue)',
  );
  ```

## PR #1638 unblocking

Separately posted `✅ Addressed` markers on the 3 open review threads on PR #1638
(comment IDs 3609603223, 3609603287, 3609603301) confirming the fixes (review ledger,
equipment test, items test assertions) already committed in `86a2bdd`. The reconciler
will resolve those threads on the next pass.

## Verification

- `npm run verify:fast` ✅ (89 test files, 1295 tests all pass)
- All 91 reconcile tests pass
- Failing test now green
