# Handoff: CI lifecycle dispatch blockers + escalation drain

**Date:** 2026-07-28  
**Session slug:** ci-lifecycle-dispatch-blockers  
**Issue:** nalfeo/Crawler#2183  
**Apple estimate:** 2🍎

## Systems touched

ci-policy

## Summary

- Made lifecycle phases explicit CI-recovery dispatch blockers in
  `.github/scripts/ci-recovery/router.mjs` by adding:
  - `ci-lifecycle-quarantined`
  - `ci-lifecycle-abandoned`
- Updated coordinator reconcile behavior in
  `.github/scripts/ci-conflict-coordinator/reconcile.mjs`:
  - On `blockingPulls.length === 0` (all non-blocking lifecycle members), it now
    evaluates ownership/human gates and drains coordinator labels, retaining
    `ci-conflict-escalation` only when ownership-gated.
  - With coordination enforcement disabled, grouping-derived escalation publication
    is now suppressed (including selection-binding drift), while ownership-gated
    escalation remains.
- Added regression coverage in:
  - `.github/scripts/ci-recovery/router.test.mjs` for quarantined/abandoned dispatch exclusion.
  - `.github/scripts/ci-conflict-coordinator/reconcile.test.mjs` for:
    - unenforced vs enforced selection-binding-drift escalation publication
    - all-non-blocking escalation draining with ownership-gated retention.

## Files touched

- `.github/scripts/ci-recovery/router.mjs`
- `.github/scripts/ci-recovery/router.test.mjs`
- `.github/scripts/ci-conflict-coordinator/reconcile.mjs`
- `.github/scripts/ci-conflict-coordinator/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-28-ci-lifecycle-dispatch-blockers.review-ledger.json`

## Verification run

- `node --test .github/scripts/ci-recovery/router.test.mjs .github/scripts/ci-conflict-coordinator/reconcile.test.mjs` ✅ (118 pass / 0 fail / 0 skipped)
- `node --test .github/scripts/ci-conflict-coordinator/state.test.mjs .github/scripts/ci-conflict-coordinator/reconcile.test.mjs` ✅ (48 pass / 0 fail / 0 skipped)
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-28-ci-lifecycle-dispatch-blockers.review-ledger.json` ✅

## Unresolved issues

- Could not post the requested pre-code plan comment directly to issue #2183 from
  this environment due to GitHub API permission failure (`gh issue comment` returned
  HTTP 403).

## Recommended next steps

- If needed, post the same implementation plan summary to issue #2183 manually from
  a credential with issue-comment permission for audit completeness.
