# 2026-09-07 - CI Recovery PR #4392 convergence

## Systems touched

ci-policy

## Summary

**Verdict:** recommended. **Estimate:** 3 apples.

The PR #4392 incident exposed a partial-release edge case: a recovery run can
persist the terminal `stale-automation-exhausted` state before a later fence
cleanup mutation completes. On the next reconcile, the state owner is already
`none`, so the ordinary duplicate-dispatch guard no longer matches; the
reconciler could dispatch the same blocker task again while the owner fence
remained attached.

The terminal decision table now treats an exact, current exhausted state with
an attached fence as cleanup work. It reuses the existing release path, keeping
the blocker active if that cleanup mutation fails and converging to the
existing no-redispatch exhausted state after success.

## Verification

- Targeted CI recovery state/reconcile tests.
- `bash scripts/agent/verify-fast.sh`.
- `npm run verify:pr-prereqs`.

## Hard-gate evidence

The deterministic reconcile decision fixture proves that a second pass over the
same exhausted progress key selects release/cleanup rather than dispatch, while
the existing exhausted-state fixture proves the following pass selects the
terminal no-redispatch action.
