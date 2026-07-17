# CI recovery state idempotency

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 🍎🍎🍎, actual 🍎🍎🍎. Exact: the change stayed within the existing
recovery state machine, router, and deterministic tests.

## What changed

- Made dynamic owner-label release idempotent when the PR attachment or repository
  label is already absent. Both cleanup calls run independently, tolerate 404, and
  recheck the atomic repository-label bit before persisting terminal state.
- Repaired stale automation-owned comments when the owner label is gone, while
  keeping missing-label, unexpired shepherd leases fail-closed. Matching lease
  release and expired lease reacquisition remain supported.
- Added a non-owning `waiting` state and `ci-recovery-waiting` PR marker for
  admission checks and human approval. Sweeps skip waiting PRs, direct events
  survive repair-window truncation, and the marker is removed only after a
  non-waiting state is persisted.
- Suppressed managed-comment PATCHes for semantically unchanged waiting and empty
  idle states while preserving behaviorful cumulative-conflict triggers. Shepherd
  heartbeat and ownership acquisition explicitly force timestamp persistence so
  lease TTL and same-ID reacquisition remain safe.
- Added deterministic state, router, and mocked GitHub API regressions for the
  PR #1208 cleanup shape, both 404 cleanup orders, waiting repetition/reactivation,
  direct-event windowing, lease expiry/release/heartbeat, and no-op persistence.
- Made every interrupted waiting exit sweep-retryable with the dedicated
  `ci-recovery-waiting-transition` marker. The marker is attached before state
  mutation and removed only after waiting cleanup succeeds; genuine waiting PRs
  remain excluded while transition-marked or waiting-plus-owner PRs are rechecked.
- No merge-train scheduling or candidate-validation files changed.

## Observe before done

- Before: PR #1208 had no dynamic owner label but retained an automation-owned
  state comment; repeated cleanup stopped on `DELETE .../issues/1208/labels/...`
  404 and repeated admission reconciliation rewrote unchanged managed comments.
- After: the mocked GitHub transaction attempts both cleanup operations, accepts
  either 404, persists `owner:none/status:idle`, and repeated waiting reconciliation
  emits `state unchanged` without a PATCH. Direct check completion persists idle
  before removing the waiting marker.
- Real artifact: `.github/scripts/ci-recovery/reconcile.mjs` executed against the
  subprocess mock GitHub API harness; router/state policy executed directly in the
  Node test runner.

## Verification

- Focused state/router/reconcile Node suite: 79 tests, 51 passed, 28 skipped by
  the documented Windows `UV_HANDLE_CLOSING` subprocess exemption, 0 failed.
  Linux CI executes the authoritative subprocess matrix. Earlier Linux execution
  exposed one over-broad missing-label optimization; the follow-up restores
  unconditional train-label cleanup while keeping waiting cleanup idempotent.
- `npm run verify:fast`
- `npx prettier --check` on all six changed recovery source/test files
- Review harness: `gpt-5.4` plan review approved with three adopted tightenings
  (`plan_divergence: minor`); `claude-sonnet-4.6` code review was clean in round 1.
  Round 2 validated four distinct concerns across the original and rebased review:
  stale waiting cleanup, same-ID lease reacquisition timestamps, behaviorful
  cumulative-conflict triggers, and non-owning transition retry. A final
  separate-model review found no high-confidence issues in the marker protocol.

## Risks

- Waiting-only wake-up depends on the existing direct CI/review/approval event
  routes. The scheduled backstop intentionally skips genuine waiting state but
  prioritizes explicit transition markers and inconsistent waiting-plus-owner
  state until cleanup succeeds.
- PR #1230 overlaps router event hygiene. When it lands, preserve its direct-only
  PR-scoped routing together with this branch's waiting/transition filtering.
- A non-404 cleanup failure remains fail-closed after both cleanup operations are
  attempted; terminal state is not fabricated while atomic ownership is uncertain.
