# Handoff: PR #1054 behind-main recovery

**Date:** 2026-07-13  
**PR:** #1054  
**PR branch:** `copilot/fix-weapon-skill-xp-misattribution`  
**Apple estimate:** 2🍎  
**Actual apples:** 2🍎  
**Verdict:** Completed

## Systems touched

ci-policy, docs-tooling

## Summary

Recovered PR #1054 from the latest behind-`main` blocker by merging current `origin/main` (`fd4f9d6`) into the branch as a clean merge commit (`1cd96b36`).

- The new mainline delta was only the CI-recovery lineage-marker fix in `.github/scripts/ci-recovery/*`; the merge required no manual conflict resolution.
- The weapon-skill attribution branch content stayed otherwise unchanged; this recovery only advanced the branch ancestry to current `main`.
- Follow-up validation surfaced one real nit in the merged CI-recovery code, so `reconcile.mjs` now logs compare-lineage failures before treating them as non-reachable markers.
- Added a fresh 2🍎 review ledger plus this coordinating handoff so the session has its own valid recovery paperwork.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `.github/scripts/ci-recovery/state.mjs`
- `.github/scripts/ci-recovery/state.test.mjs`
- `docs/knowledge/handoffs/2026-07-13-pr1054-rebase-recovery.md`
- `docs/knowledge/review-ledgers/2026-07-13-pr1054-rebase-recovery.review-ledger.json`

## Verification run

```bash
cd /home/runner/work/Crawler/Crawler
npm run verify:fast
npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-13-pr1054-rebase-recovery.review-ledger.json
npm run verify:pr-prereqs
```

## Notes

- Attempting to acquire the PR-shepherd lease via `gh workflow run ci-recovery.yml ... operation=lease-acquire` returned `HTTP 403`, so this recovery proceeded without a refreshed lease comment.
