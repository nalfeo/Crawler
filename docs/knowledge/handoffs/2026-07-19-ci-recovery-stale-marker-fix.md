# Handoff: CI Recovery Stale-Marker Auto-Resolution Fix

**Date:** 2026-07-19  
**Session slug:** ci-recovery-stale-marker-fix  
**Branch:** copilot/fix-ci-recovery-loop-again  
**PR:** #1665 (stale trusted-marker guard on outdated threads)  
**Apple estimate:** 2🍎

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

Note: PR #1664 (CI recovery loop incident for PR #1638) listed three blockers that were
all `isOutdated: false`. Because `shouldAutoPostOutdatedMarker` only runs for outdated
threads, the fix in this PR does not address that incident. PR #1664 requires a separate
investigation.

## Fix

Added a trusted-marker predicate before the outdated-marker loop in
`.github/scripts/ci-recovery/reconcile.mjs`:

```javascript
function shouldAutoPostOutdatedMarker(candidate) {
  if (!candidate.isOutdated) return false;
  if (shouldResolveThread(candidate, headSha, reachableMarkerShas)) return false;
  // Return false when the latest comment is a trusted addressed marker.
}
```

The outdated-marker loop now excludes threads whose latest comment is a trusted
addressed marker. This covers both definitively stale markers and markers whose
lineage check failed transiently, while untrusted marker text cannot suppress the
normal outdated-thread path.

```javascript
unresolvedThreads.filter(shouldAutoPostOutdatedMarker);
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
- Strengthened the transient-lineage regression to use an outdated thread and
  assert that the reconciler neither replaces its trusted marker nor resolves it.

## Consolidation

- Compared current `main` and sibling PRs #1663, #1615, #1614, #1601, #1598,
  #1597, #1625, and #1603.
- Absorbed #1663's compatible fail-closed trusted-marker predicate.
- Rejected sibling semantics that resolve malformed markers, discard outdated
  blockers, or alter blocker fingerprints; those contradict this PR's
  marker-gated stale-recovery contract.

## Apples

Estimated 2 apples, actual 2 apples.

## PR #1638 unblocking

Separately posted `✅ Addressed` markers on the 3 open review threads on PR #1638
(comment IDs 3609603223, 3609603287, 3609603301) confirming the fixes (review ledger,
equipment test, items test assertions) already committed in `86a2bdd`. The reconciler
will resolve those threads on the next pass.

## Verification

- `npm run verify:fast` ✅ (89 test files, 1295 tests all pass)
- All 91 reconcile tests pass
- Failing test now green
