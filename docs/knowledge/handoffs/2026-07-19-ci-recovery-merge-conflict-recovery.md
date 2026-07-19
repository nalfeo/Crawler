# Handoff: CI recovery merge-conflict recovery

**Date:** 2026-07-19  
**PR:** #1627  
**PR branch:** `copilot/fix-ci-recovery-loop-1623`  
**Apple estimate:** 2🍎  
**Actual apples:** 2🍎  
**Verdict:** Completed

## Systems touched

ci-policy

## Summary

Recovered PR #1627 from a real `main` merge conflict and kept both sides of the
CI-recovery behavior:

- merged `origin/main` into `copilot/fix-ci-recovery-loop-1623`
- resolved the single textual conflict in
  `.github/scripts/ci-recovery/reconcile.mjs` by keeping both the branch's
  prior-top-level-reply correlation logic and `main`'s stricter
  review-thread-marker guidance
- updated two reconcile regression fixtures so the stale-marker and prior-reply
  summary tests remain on their intended code paths after `main`'s new
  outdated-thread auto-marker behavior

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/handoffs/2026-07-19-ci-recovery-merge-conflict-recovery.md`

## Verification run

```bash
cd /home/runner/work/Crawler/Crawler
node --test .github/scripts/ci-recovery/reconcile.test.mjs --test-name-pattern='stale-marker thread includes recovery hint|prior-reply thread includes hint|prior-reply hint ignores non-recovery collaborator|transient compare failure|outdated-marker'
npm run verify:fast
npm run verify:pr-prereqs
```

## Unresolved issues

None.
