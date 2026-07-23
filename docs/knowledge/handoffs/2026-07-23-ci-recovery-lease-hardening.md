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

- Shepherd leases now expire after five minutes without a heartbeat, with no grace period; shepherd guidance requires a two-minute heartbeat cadence.
- Unexpected uncaught exceptions and unhandled rejections attempt one ownership release, report cleanup failures without masking the original error, and avoid mutating a review-wake PR after its expected head moved.
- Terminal orphan cleanup removes both the PR attachment and repository owner-label fence.

## Verification

- Targeted CI recovery tests: 154 passed.
- `git diff --check`: passed.
- `npm run verify:fast`: blocked because the sandbox could not install the locked `typescript`/ESLint dependencies (`ENOTFOUND ms-feed-12.pkgs.visualstudio.com`); targeted Node tests and syntax checks passed.
- Secret scan: passed.
- Review ledger validated after recording the final code-review round.

## Review harness

- Plan review (`gpt-5.4`): 3 concerns resolved; `plan_divergence=minor`.
- Code review (`claude-sonnet-4.6`): three bounded rounds; final round clean. Findings addressed included lease-release reentrancy, orphan PR-label cleanup, and metadata-fenced unexpected-error cleanup.
