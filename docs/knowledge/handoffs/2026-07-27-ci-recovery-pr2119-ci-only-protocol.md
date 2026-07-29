# Handoff: CI recovery PR #2119 ci-only protocol hardening

## Date

2026-07-27

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

- Investigated CI-recovery loop incident for PR #2119 using the linked blocker logs and CI-recovery run logs.
- Confirmed the blocker root cause was a CI failure (`.github/scripts/sweep-budget.test.mjs` assertion mismatch) rather than marker-parser, permission-grant, or review-thread-resolution defects.
- Hardened the recovery task-body protocol for **CI-only blocker sets** so dispatch comments now explicitly require push-based progress (fix + push + rerun) and omit review-thread-only marker instructions that do not apply when no review-thread blockers are present.
- Added a regression test proving CI-only task comments include CI-only guidance and exclude review-thread protocol text.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-27-ci-recovery-pr2119-ci-only-protocol.review-ledger.json`

## Verification

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅ (after ledger + handoff were added)

## Observe before done

- This change targets CI automation scripts only (`.github/scripts/ci-recovery/*`). Verification used the script-level reconcile test harness and repo verification gates; no gameplay/runtime artifact was changed.

## Notes / unresolved

- Unable to post the requested pre-code plan comment on issue #2127 from this environment: `gh issue comment` and `gh api .../issues/.../comments` both returned 403 (GraphQL forbidden / DNS monitoring proxy block).
