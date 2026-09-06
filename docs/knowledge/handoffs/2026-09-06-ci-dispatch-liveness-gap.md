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
from dispatching concurrently with an active owner. Regression coverage now
asserts both ownership cases are excluded.

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
- `bash scripts/agent/verify-fast.sh` — passed.

## Runtime observation

This is CI tooling, not a game runtime or visual change. The deterministic
workflow contract and Node regression fixture cover the real scheduled sweep
and dispatch request path.

## Recommended next steps

The ready-for-review change should be reviewed under the 3-apple independent
post-diff review policy; the attached review finding was addressed in this
repass.
