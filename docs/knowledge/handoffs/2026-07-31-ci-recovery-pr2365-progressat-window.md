# Handoff: CI recovery PR #2365 progressAt retry window fix

## Date

2026-07-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 estimated, 2🍎 actual.

## Summary

Investigated PR #2365 CI-recovery loop behavior and confirmed a deterministic mutation-sequence defect in `.github/scripts/ci-recovery/reconcile.mjs`:

- On the `lease-reaper` trigger, the duplicate-dispatch stale-retry path (`R33` / `stale-automation-retry`) carried forward stale `progressAt`.
- That stale timestamp could make the very next sweep immediately classify the freshly redispatched attempt as exhausted (`stale-automation-exhausted`) before the new repair run had a real liveness window.

Implemented the smallest fix:

- Keep carrying the attempt counter.
- Refresh `progressAt` for the newly dispatched retry attempt (do not keep the frozen stale timestamp).

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-31-ci-recovery-pr2365-progressat-window.review-ledger.json`

## Verification

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` ✅
- `npm run verify:fast` ❌ (environment dependency install/network resolution failure to package feed)
- `npm run verify:pr-prereqs` initially ❌ (missing handoff + ledger), then addressed by adding this handoff and review ledger.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-31-ci-recovery-pr2365-progressat-window.review-ledger.json` ✅

## Unresolved / follow-up

- Could not post the required pre-code plan comment on issue #2407 from this environment (`gh issue comment` returned HTTP 403). The plan is preserved in session output and should be posted when issue-comment permissions are available.
