# Handoff: CI recovery cancelled-run retrigger

## Date

2026-07-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 estimated, 2🍎 actual.

## Summary

- Extended CI-recovery retrigger classification to treat required `cancelled` workflow runs as retriggerable alongside `action_required`.
- Updated the liveness backstop sweep to scan both `action_required` and `cancelled` runs, then dispatch retriggers only for open non-draft PRs.
- Updated reconcile blocker classification to emit `ci-retrigger` blockers for required cancelled runs with explicit wording: cancelled (not failed).
- Kept existing guardrails: required workflow path filtering, same-repo checks, latest-run collapse, and capped sweep dispatch.

## Files touched

- `.github/workflows/ci-liveness-sweep.yml`
- `.github/workflows/action-required-retrigger.yml`
- `.github/scripts/ci-recovery/action-required-retrigger.mjs`
- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/action-required-retrigger.test.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-31-ci-cancelled-retrigger.review-ledger.json`

## Verification

- `node --test .github/scripts/ci-recovery/action-required-retrigger.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs` ✅
- `npm run verify:fast` ❌ blocked by dependency install outage (`ENOTFOUND ms-feed-12.pkgs.visualstudio.com`) in this environment.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-31-ci-cancelled-retrigger.review-ledger.json` ✅
- `parallel_validation` ✅ (CodeQL/security scan clean; review tool unavailable in environment)

## Unresolved issues

- Full fast-verify is still blocked in this session environment until dependency fetch can reach `ms-feed-12.pkgs.visualstudio.com`.

## Recommended next steps

1. Re-run `npm run verify:fast` in CI or in an environment with npm feed connectivity.
2. Validate on a real fixture PR that a latest required `cancelled` run is re-dispatched by liveness sweep and classified as cancelled (not failed) in recovery blocker text.
