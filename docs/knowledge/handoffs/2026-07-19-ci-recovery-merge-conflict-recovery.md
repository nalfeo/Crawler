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
- compared duplicate PR #1623 and retained #1627 as the canonical superset
- removed the unrelated generated sprite-catalog delta introduced by the merge
  recovery, restoring `src/shared/data/sprite-catalog.json` exactly to `main`
- preserved a known recovery reply when a reviewer adds a later follow-up by
  scanning backward to the newest non-marker recovery comment, while stopping
  at any newer addressed marker
- merged the later `main` queue, regenerated the handoff index conflict, and
  kept the stale-marker regression on its intended blocker-summary path
- repaired the newly merged verifier fixture so Windows-host paths stay native
  for `npx tsc` while files consumed directly by WSL bash use translated paths
- retained top-level recovery context across reviewer follow-ups by indexing
  prior task replies by stable GraphQL thread ID as well as the digest-bearing
  blocker ID used for progress tracking
- limited marker boundaries to trusted collaborators and bots so untrusted
  marker-shaped comments cannot suppress prior recovery hints
- rejected fingerprint-to-blocker mappings from untrusted issue comments so a
  forged task marker cannot overwrite the real recovery correlation
- treated trusted `Not applicable` replies as recovery boundaries alongside
  addressed markers when a reviewer later reopens the conversation
- normalized prior-reply hints to one bracket-safe line before embedding them
  in recovery task summaries
- regenerated the handoff index from source and escaped dynamic regex fixtures
  consistently in the new regression tests

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `tests/unit/verify-fast-typecheck.test.ts`
- `src/shared/data/sprite-catalog.json`
- `docs/knowledge/handoffs/2026-07-19-ci-recovery-merge-conflict-recovery.md`

## Verification run

```bash
cd /home/runner/work/Crawler/Crawler
node --test .github/scripts/ci-recovery/reconcile.test.mjs --test-name-pattern='stale-marker thread includes recovery hint|prior-reply thread includes hint|prior-reply hint ignores non-recovery collaborator|transient compare failure|outdated-marker'
node --test .github/scripts/ci-recovery/reconcile.test.mjs
npx vitest run tests/unit/verify-fast-typecheck.test.ts --project unit
npm run verify:fast
npm run verify:pr-prereqs
```

## Unresolved issues

None.
