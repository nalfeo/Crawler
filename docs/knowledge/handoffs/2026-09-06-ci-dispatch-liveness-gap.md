# CI recovery dispatch liveness gap

## Verdict and scope

Recommended. Estimated 3 apples (tooling-only); actual 3 apples, exact estimate.
The hard gate is a deterministic bounded dispatch for stale, open, non-draft,
same-repository blocked PRs, carrying current head and base metadata, while
protected and invalid candidates produce no dispatch.

## Systems touched

ci-policy

## Summary

Added a bounded CI Liveness Sweep backstop for never-summoned blocked PRs. It
sorts and caps candidates, excludes active ownership/merge-train wait decisions,
re-fetches each PR, rejects state or repository changes, and dispatches the
trusted `ci-recovery.yml` workflow with `ci-liveness-sweep`,
`expected_head_sha`, and `expected_base_ref`.

The review repass also protects the canonical `skip-active-shepherd` and
`skip-active-copilot-progress` ownership decisions, preventing the backstop
from dispatching concurrently with an active owner. The final repass also
protects canonical conflict-order and conflict-rebase backoff waits, and
re-fetches current `ci-owner-pr-*` and
`ci-recovery-waiting-transition` labels before dispatch to close the
time-of-check/time-of-use ownership gap. Regression coverage asserts all of
these cases are excluded. This repass additionally re-fetches the current
`merge-train`, `merge-train-blocked`, `merge-train-recovery-pending`,
`merge-train-validation-failed`, and `ci-conflict-order-wait` labels before
dispatch, protecting merge-train ownership even when its decision record is
outside the lookback window. It also protects current conflict escalation,
recovery-waiting, and human-approval labels. The dispatch workflow ref remains
the repository default branch for locating `ci-recovery.yml`, while each
candidate's actual base ref is validated and passed as `expected_base_ref`;
release and maintenance branch PRs are therefore not silently skipped.

## Files touched

- `.github/scripts/ci-recovery/harvest-liveness.mjs`
- `.github/scripts/ci-recovery/harvest-liveness.test.mjs`
- `.github/workflows/ci-liveness-sweep.yml`
- `tests/unit/ci-liveness-sweep-workflow.test.ts`
- `tests/unit/ci-knobs-guard.test.ts`
- `docs/agent-os/policies/ci-config-knobs.md`

## Verification run

- `node --test .github/scripts/ci-recovery/harvest-liveness.test.mjs` — passed.
- `npx vitest run tests/unit/ci-liveness-sweep-workflow.test.ts --project unit` — passed.
- `bash scripts/agent/verify-fast.sh` — passed.
- `npm run verify:pr-prereqs` — passed after this handoff was added.
- Review repass: active shepherd and active Copilot ownership fixtures pass with
  zero redispatches.
- `npx vitest run tests/unit/ci-liveness-sweep-workflow.test.ts tests/unit/ci-knobs-guard.test.ts --project unit` — passed (207 tests).
- Final repass: `node --test .github/scripts/ci-recovery/harvest-liveness.test.mjs`
  — passed (38 tests), including conflict waits and current merge-train
  ownership labels and non-default base refs.
- `bash scripts/agent/verify-fast.sh` — passed.

## Runtime observation

This is CI tooling, not a game runtime or visual change. The deterministic
workflow contract and Node regression fixture cover the real scheduled sweep
and dispatch request path.

## Review status

The attached review findings were addressed in this repass. The ready-for-review
change still requires the one independent post-diff review mandated for a
3-apple tooling change.
