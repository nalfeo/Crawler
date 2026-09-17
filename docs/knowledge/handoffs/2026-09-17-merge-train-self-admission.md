# Handoff — Merge-train self-admission

## Systems touched

merge-train, ci-recovery ownership boundary, agent documentation

## Summary

- Moved `merge-train` queue-label admission into the trusted merge-train
  reconciler so a disabled CI Recovery worker cannot strand green PRs.
- Reused the existing canonical live admission predicate and added a final
  immutable-head/state read before labeling.
- Preserved FIFO ordering, the six-entry train bound, and all recovery,
  active-lease, already-landed, quarantine, conflict-order, and terminal-label
  exclusions.
- Independent review found and fixed a candidate-local API failure path that
  could otherwise abort the existing queue; failed admission reads now log and
  yield to later candidates.
- Updated the operating guide and recorded the ownership decision in ADR 0107.

## Planning contract

- Hard gate: with CI Recovery disabled, an open same-repository PR with green
  required checks, resolved threads, and valid review evidence receives the
  `merge-train` label from the train itself before queue construction.
- Gate status: READY.
- Routing: DevOps owns implementation; QA owns focused admission and source-order
  regression coverage; Producer coordinates the ownership/documentation seam.
- Dependencies: admission selection → trusted label mutation → queue construction.
- Human routing corrections: none.
- Slices: 3; critical path: all three sequential; parallelism: 1.

## Validation

- `node --test .github/scripts/merge-train/state.test.mjs .github/scripts/merge-train/reconcile.test.mjs`
- Remaining required repository gates are recorded in the PR description.

## Follow-up

- After merge, the next scheduled reconciliation should self-admit any currently
  converged unqueued PR. CI Recovery may remain disabled until its Copilot
  mutation behavior is separately scoped.
