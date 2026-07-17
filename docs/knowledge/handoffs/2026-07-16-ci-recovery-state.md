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
  idle states. Shepherd heartbeat explicitly forces timestamp persistence so lease
  TTL behavior is unchanged.
- Added deterministic state, router, and mocked GitHub API regressions for the
  PR #1208 cleanup shape, both 404 cleanup orders, waiting repetition/reactivation,
  direct-event windowing, lease expiry/release/heartbeat, and no-op persistence.
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

- `node --test ".github/scripts/ci-recovery/*.test.mjs"`: 97 tests, 68 passed,
  29 skipped by the documented Windows `UV_HANDLE_CLOSING` subprocess exemption,
  0 failed. The pure state/router regressions executed locally; Linux CI owns the
  authoritative subprocess execution.
- `npm run verify:fast`
- `npx prettier --check` on all six changed recovery source/test files
- Review harness: `gpt-5.4` plan review approved with three adopted tightenings
  (`plan_divergence: minor`); `claude-sonnet-4.6` code review was clean in round 1.

## Risks

- Waiting wake-up depends on the existing direct CI/review/approval event routes;
  the scheduled backstop intentionally does not consume waiting PRs.
- A non-404 cleanup failure remains fail-closed after both cleanup operations are
  attempted; terminal state is not fabricated while atomic ownership is uncertain.
