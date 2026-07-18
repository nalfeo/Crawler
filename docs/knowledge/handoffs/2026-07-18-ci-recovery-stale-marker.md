# Handoff: fix(ci-recovery): detect stale ✅ Addressed markers

**Date:** 2026-07-18  
**Session slug:** ci-recovery-stale-marker  
**Apple estimate:** 2🍎

## Summary

Investigated CI recovery loop incident #1300 filed for PR #1266. Found that the
Copilot ci-review-validator replied to review threads with `✅ Addressed in
8747c25` but that commit was created locally and never pushed to GitHub. The
reconciler's compare API (`/compare/8747c25...d4b68d28`) returned 404, so those
threads stayed unresolved. With the same 10 threads unresolved across 2 retry
attempts the fingerprint never changed, triggering the loop-exhaustion incident.

**Root cause**: The recovery agent can reply to review threads with a locally-
created commit SHA before pushing it. If the push is later abandoned or
squashed, the compare API 404s for that SHA forever and those threads can never
be auto-resolved by the existing `shouldResolveThread` path.

**Fix**: After building `reachableMarkerShas`, scan unresolved threads for the
case where the last trusted comment has a `✅ Addressed in <sha>` marker but the
SHA is NOT reachable from the current head. Store these in
`staleAddressedMarkerByThread` and prepend a targeted hint to the blocker
summary. The next recovery agent then knows to re-post the marker with the
correct current-head SHA rather than re-investigating the underlying concern.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs` — stale-marker detection + blocker annotation
- `.github/scripts/ci-recovery/reconcile.test.mjs` — regression test

## Systems touched

ci-recovery

## Verification

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` — 84/84 pass (incl. new regression)
- `npm run verify:fast` — 1260/1260 tests pass

## Unresolved issues

The 10 review threads on PR #1266 still need to be addressed by the ci-review-validator.
With this fix deployed, the next reconciler run will detect the 6 stale `8747c25` markers
and give the agent targeted instructions to re-post them with the current HEAD SHA.

## Recommended next steps

After this PR merges to main, trigger the CI recovery for PR #1266 so the
updated reconciler can generate an annotated task body for the stale-marker
threads.
