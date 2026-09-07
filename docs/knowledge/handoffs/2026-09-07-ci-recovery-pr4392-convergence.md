# 2026-09-07 - CI Recovery PR #4392 convergence

## Systems touched

ci-policy

## Summary

**Verdict:** recommended. **Estimate:** 2 apples.

The PR #4392 incident looked like a partial-release edge case: a recovery run can
persist the terminal `stale-automation-exhausted` state before the fence cleanup
mutation completes, leaving the owner fence attached while the state owner is
already `none`.

An initial attempt added an alternative to the terminal decision table (`R34`)
for `labelExists && owner === 'none' && status === 'idle'`. Post-diff review
showed that alternative is unreachable from the real reconciler: `reconcile.mjs`
classifies exactly that state as an `orphanedOwnershipArtifact` **before**
`selectTerminalAction` runs, removes the residual fence by node id, and sets
`labelExists = false`, after which the pre-existing `GC-EXHAUSTED-SKIP` row
already selects the no-redispatch action. The dead guard was therefore removed.

What remains is the coverage gap that hid this: the exhausted-plus-residual-fence
shape was only exercised at the decision-table level. It is now covered by a
production-path `runScript` subprocess test that drives the real reconciler.

## Verification

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` (194 tests, all pass).
- `bash scripts/agent/verify-fast.sh`.

## Hard-gate evidence

The new subprocess test asserts, against the real reconciler, that a persisted
exhausted state with a residual repository fence (also attached to the PR) is
cleaned up by node id (`orphaned-fence-cleanup pr=#42 status=idle`) and then
converges on `skip pr=#42 reason=stale-automation-exhausted`, posting no new
task comment. It passes with no change to `dispatch-table.mjs`, confirming the
production path was already correct.
