# ADR 0107: Merge Train Owns Queue Admission

## Status

Accepted

## Date

2026-09-17

## Estimated Complexity

🍎 x 3 — moves a trusted mutation boundary and requires race-safe admission tests.

## Context

The repository-managed merge train consumed only PRs carrying the `merge-train`
label, while CI Recovery was the sole writer of that label. PR #4572 disabled
the entire CI Recovery reconciliation job to stop automated Copilot restarts.
The router continued to dispatch successful-looking recovery workflows, but the
workers skipped, so green PRs never entered the train.

Admission and promotion also had split ownership despite already sharing the
same canonical admission predicate. This allowed an unrelated recovery-policy
kill switch to disable all merging without disabling the merge train itself.

## Decision

The trusted merge-train reconciliation job owns queue admission. At the start
of every pass it:

1. filters open, non-draft, same-repository PRs targeting `main`;
2. excludes PRs already queued, actively leased, already landed, abandoned,
   blocked, quarantined, awaiting conflict order, or carrying a terminal train
   marker;
3. evaluates remaining PRs oldest-first with the existing live `eligible()` /
   `isAdmissible()` policy;
4. re-reads the PR immediately before mutation and rejects stale heads or
   metadata; and
5. attaches `merge-train` only until the six-entry train is full.

The scan runs whether the existing queue is empty or non-empty. CI Recovery
continues to repair failed checks, conflicts, and review blockers, but is no
longer required for a converged PR to enter the train.

## Consequences

### Positive

- Disabling Copilot recovery cannot silently disable merge-train admission.
- Admission, candidate construction, and promotion use one trusted controller
  and one canonical eligibility policy.
- FIFO order and the existing six-PR capacity remain intact.
- A stale head or state transition fails closed before the queue-label write.

### Negative

- A train pass may perform admission reads for multiple unqueued PRs before it
  finds enough eligible entries.
- Merge-train reconciliation now owns an additional PR-label mutation.

### Risks

- GitHub state can change after the final read and before labeling. Candidate
  construction and promotion already re-run full admission, so a raced label
  cannot authorize a merge and is removed on the same or next pass.
- Filtering too aggressively could strand PRs; focused tests cover every
  recovery and terminal train marker.

## Alternatives Considered

- Re-enable all of CI Recovery. Rejected because it also restores the Copilot
  reassignment behavior that PR #4572 intentionally disabled.
- Split CI Recovery into admission and repair jobs. Viable, but retains a
  cross-workflow dependency even though the train already has the canonical
  admission implementation and required App permissions.
- Auto-label only when the queue is empty. Rejected because a non-empty queue
  would prevent newly converged PRs from entering and could recreate starvation.
