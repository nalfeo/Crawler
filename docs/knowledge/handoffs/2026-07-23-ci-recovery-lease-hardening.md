# Handoff: CI recovery lease hardening

## Date

2026-07-23

## Persona

Producer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Summary

- Shepherd leases keep ADR-0058's **30-minute TTL + 5-minute grace** (a lock-hardening
  change must not 6× faster-expire the lease). Reviewer threads suggesting a 5-minute
  expiry were declined with that rationale rather than adopted (rule #11: do not weaken;
  escalate the reasoning instead). No lease-threshold constants or docs changed vs
  `origin/main`.
- **Bug 1 (`releaseUnexpectedOwnership`):** an unexpected crash after acquiring ownership
  on a review-wake run no longer bails just because `EXPECTED_HEAD_SHA` is set. It now
  releases ownership we hold, only leaving it untouched when the trust fence actually
  moved (a genuine `expectedMetadataRejection`), so a mid-acquire crash cannot leak the
  lock.
- **Bug 2 (terminal orphaned-fence cleanup):** removes both the PR attachment and the
  repository owner-label fence, but re-checks live ownership first (`fetchOwnershipFacts`
  + incarnation node-id match) and deletes by node id, so it can never TOCTOU-delete a
  fresh owner's lock.
- **Round-2 Finding 2(b) (clean-skip partial-fence leak):** a metadata move at the
  `state-comment` phase inside `acquire()` triggers `skipForExpectedMetadata` →
  `process.exit(0)`. Because that is a *clean* exit, the uncaught-error handler never
  runs, so the just-armed fence + PR label leaked until the next orphaned-fence sweep.
  Fixed by cleaning the armed partial fence before the clean exit, guarded by a
  `cleaningPartialFence` re-entrancy flag so the per-mutation metadata guards no-op
  while deleting our own re-verified incarnation (this also lets the crash path complete
  cleanup on a moved head instead of throwing). Commit `a94231b15`.

## Verification

- Full CI-recovery Node suite (`reconcile` + `state` + `review-wake-bridge` +
  `unexpected-error`): 207 tests, 0 fail (12 skipped locally — the Windows
  UV_HANDLE_CLOSING exit-0 subprocess flake; those assertions run on Linux CI).
- Every regression test proven **non-vacuous** via guard-neuter mutation runs (Bug 1b,
  Bug 2b, Bug 3, Bug 3b): neutering each fix makes its test fail on the exact missing
  log line / mutation.
- Real-artifact note: this is CI-automation script code (`.github/scripts/ci-recovery/`),
  not a game system — the authoritative artifact is the ci-recovery reconcile workflow
  run plus the subprocess-level regression tests that spawn `reconcile.mjs` against a
  mock GitHub server, not a lab.
- `git diff --check`: passed.
- `npm run verify:fast`: (re-run in worktree before push — see PR).

## Review harness

- Plan review (`gpt-5.4`): 3 concerns resolved; `plan_divergence=minor` (the
  threshold-direction correction — keep 30 min, don't shorten to 5 min).
- Code review: **2-round cap reached, then escalated to human** (not looped further).
  - Round 1 (`claude-sonnet-4.6`): 3 concerns, all fixed with non-vacuous regression
    tests (commit `48ace4cfb`).
  - Round 2 (`gpt-5.6-sol`): 3 concerns. Finding 2(b) VALID + in-scope → fixed
    (`a94231b15`). The other two are **pre-existing architectural residuals** requiring a
    separate CAS/generation-token redesign, out of scope for this cleanup PR:
    (1) a release-path micro-TOCTOU only reachable after a >30-min stall the lease TTL
    already dominates; (2) an ambiguous POST response before `pendingFenceNodeId` is
    assigned — universal to every POST, GitHub-side, backstopped by the orphaned-fence
    sweep. **Escalated to nalfeo** to decide on a follow-up CAS-redesign issue.

## Residual limitations (escalated)

The two round-2 residuals above are not closable without a CAS/generation-token
ownership protocol (a larger redesign than this cleanup PR). Recommend a separate tracked
issue rather than expanding this PR's scope.
