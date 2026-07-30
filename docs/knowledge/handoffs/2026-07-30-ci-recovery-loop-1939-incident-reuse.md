# Handoff: Reuse prior PR loop incidents for repeated PR #1939-style recurrences

**Date:** 2026-07-30  
**Session slug:** ci-recovery-loop-1939-incident-reuse  
**Apple estimate:** 2🍎  
**Closes:** #2354

## Systems touched

ci-recovery

## Summary

Adjusted PR loop-incident filing so a repeated recurrence for the same PR reuses
the latest closed loop-incident issue instead of opening a fresh duplicate issue
with `Repetition count: 1` again.

## Root cause

PR #1939 had already produced multiple closed loop-incident issues with the same
title (`CI recovery loop: PR #1939`). `fileLoopIncident(...)` only searched open
issues, so once a prior incident was closed the next identical recurrence opened
another issue instead of preserving first-seen history and incrementing the
repetition count on the same incident thread.

## Fix

- `.github/scripts/ci-recovery/loop-incident-lib.mjs`
  - search labeled loop incidents with `state=all`
  - prefer an existing open incident when present
  - otherwise reopen the most recently updated closed incident for the same PR
  - preserve the original `First seen` timestamp and increment `Repetition count`

## Tests

- `.github/scripts/ci-recovery/loop-incident-lib.test.mjs`
  - added a regression test that reopens the most recent closed incident for the
    same PR and confirms no duplicate issue is created

## Verification

- `node --test .github/scripts/ci-recovery/loop-incident-lib.test.mjs` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-30-ci-recovery-loop-1939-incident-reuse.review-ledger.json` ✅
- `npm run verify:fast` ⚠️ blocked in this sandbox because dependencies are not
  installed and outbound package fetches fail (`ENOTFOUND ms-feed-12.pkgs.visualstudio.com`)

## Notes

- I prepared the required detailed plan comment for issue #2354, but posting it
  from this sandbox was blocked by the available GitHub auth/proxy path (`403`
  / `Blocked by DNS monitoring proxy`). The comment text remains in
  `/tmp/pr2354-plan-comment.md` for recovery if needed.
