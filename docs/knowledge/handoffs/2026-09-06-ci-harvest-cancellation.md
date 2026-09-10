# CI recovery harvest cancellation fix

**Date:** 2026-09-06
**Verdict:** Recommended
**Apples:** 3 estimated

## Systems touched

ci-policy, ci-recovery, merge-train

## Summary

The CI recovery workflow did not explicitly disable cancellation for its
per-PR concurrency lane. During dispatch bursts, a pending harvest could be
cancelled before it created a job, producing the stale-session liveness
incident. The workflow now declares non-cancelling queue behavior, with a
regression contract test covering the per-PR group and queue settings.

## Files touched

- `.github/workflows/ci-recovery.yml`
- `.github/scripts/ci-recovery/harvest-liveness.test.mjs`

## Verification

- `node --test .github/scripts/ci-recovery/harvest-liveness.test.mjs`
- `npm exec vitest run tests/unit/ci-liveness-sweep-workflow.test.ts`
- `bash scripts/agent/verify-fast.sh`
- `npm run verify:pr-prereqs` (passed after this handoff was added)

## Unresolved issues

The post-deployment hard gate requires a scheduled CI Liveness Sweep to
observe a completed successful CI Recovery reconcile and close the managed
incident. That observation belongs to the deployment workflow.

## Recommended next steps

Merge through the repository merge train, then inspect the next scheduled
CI Liveness Sweep and CI Recovery run artifacts for a non-cancelled successful
harvest and managed incident closure.
