# CI recovery loop: PR #2963 rate-limit crash fix

## Summary

Investigated the stalled CI recovery loop for PR #2963 and fixed a deterministic router failure mode: concurrent outstanding-run telemetry requests could all fail under installation rate limiting, and leftover rejected promises surfaced as an uncaught failure that terminated the `route` job.

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎 — localized CI-recovery router promise-settlement hardening plus one focused regression.

## Changes

- Hardened `.github/scripts/ci-recovery/router.mjs` by changing `countOutstandingWorkflowRuns` to use `Promise.allSettled` and then rethrowing a captured rejection after all requests settle.
- Preserved existing fail-closed behavior (rate-limited telemetry defers normal dispatches) while eliminating concurrent unhandled-rejection crash paths.
- Added a subprocess regression test in `.github/scripts/ci-recovery/router.test.mjs` that rate-limits all runner-pressure workflow queries simultaneously and asserts the router exits cleanly without dispatching.

## Verification

- `node --test .github/scripts/ci-recovery/router.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs` _(initial run failed due missing handoff; this handoff addresses that prerequisite)_
