# Handoff: Merge train update-branch 403 crash fix

## Date

2026-07-29

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎 (single catch-block fix + source-string test). Tooling-only change — cap
applies. No `apples:record` JSON required for 1🍎.

## Summary

Fixed a queue-deadlocking crash in `reconcile.mjs` where a 403 response from
the GitHub `update-branch` API was re-thrown, crashing the entire reconcile
process for every subsequent invocation. This was the root cause of the ~90-min
queue stall on 2026-07-29 (~05:33–07:03 UTC) reported in issue #2305.

### Root cause

The `catch` block around the `update-branch` PUT call had:
```js
if (err.status !== 422) throw err;
```
This means any non-422 error (403 permission denied, 404, 5xx) was rethrown as
an uncaught exception, crashing the Node process before it could process any
other PR in the queue.

### Fix

Removed the conditional re-throw. All update-branch errors are now logged to
stderr (non-fatal) and fall through to the existing `break`, which already
provided the correct FIFO semantics (halt admission for this pass, let the BEHIND
PR retry next cycle).

The 422 path was already safe; this change unifies all error paths to the same
log-and-skip behavior.

### Test

Added a source-string test in `tests/unit/merge-train-d2-behind-wiring.test.ts`
asserting:
- `process.stderr.write` appears in the catch block (errors are logged)
- `throw err` does NOT appear in the catch block (no re-throw)

## Files changed

- `.github/scripts/merge-train/reconcile.mjs` — removed `throw err` from
  update-branch catch block; unified error logging
- `tests/unit/merge-train-d2-behind-wiring.test.ts` — added re-throw regression
  test
- `docs/knowledge/review-ledgers/2026-07-29-merge-train-update-branch-crash-fix.review-ledger.json`
  — 1🍎 ledger (no review stages required)
