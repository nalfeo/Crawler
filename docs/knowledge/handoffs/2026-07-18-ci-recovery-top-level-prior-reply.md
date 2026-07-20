# Handoff: CI recovery top-level prior-reply correlation

**Date:** 2026-07-18  
**PR:** #1627  
**PR branch:** `copilot/fix-ci-recovery-loop-1623`  
**Apple estimate:** 2🍎  
**Actual apples:** 2🍎  
**Verdict:** Completed

## Systems touched

ci-policy, docs-tooling

## Summary

Fixed the remaining PR #1627 review gap by teaching `reconcile.mjs` to reuse top-level Copilot recovery replies that explicitly quote an earlier `crawler-ci-task` fingerprint, even when the unresolved review thread itself still has only the original reviewer comment.

- Parsed task-comment fingerprints plus listed review-thread blocker IDs from top-level PR comments.
- Correlated known Copilot-authored top-level replies back to those blocker IDs and surfaced their non-marker text as the prior-reply hint.
- Updated the regression tests to model the real PR #1623 topology: single-comment review thread + separate top-level recovery reply, plus a negative case for a non-recovery collaborator.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/handoffs/2026-07-18-ci-recovery-top-level-prior-reply.md`

## Verification run

```bash
cd /home/runner/work/Crawler/Crawler
node --test .github/scripts/ci-recovery/reconcile.test.mjs
npm run verify:fast
```

## Unresolved issues

- None in the local verification pass.

## Recommended next steps

1. Run `npm run verify:pr-prereqs` on the branch after fetching `origin/main` so the review-ledger guard sees the existing branch paperwork before the thread is closed.
