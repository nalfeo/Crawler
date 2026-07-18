# Handoff: CI Recovery — Support ✅ Not applicable Marker

**Date:** 2026-07-18  
**Session slug:** ci-recovery-not-applicable-marker  
**Apple estimate:** 1🍎

## Summary

Fixed a deterministic defect in the CI recovery marker parser that caused the
recovery loop to stall permanently when a trusted agent replied to a review
thread with `✅ Not applicable` instead of `✅ Addressed in <sha>`.

## Root Cause

`shouldResolveThread()` in `state.mjs` delegated to `markerNamesHead()` which
only matched the pattern `✅ Addressed in <sha-or-commit-url>`. For
deterministically non-applicable findings (no code change needed), recovery
agents correctly replied with `✅ Not applicable — <reason>`, but the parser
found no SHA, `markerNamesHead` returned `false`, and the thread could never
be auto-resolved. After 2 exhausted recovery attempts the incident was
escalated (#1618).

## Files Touched

- `.github/scripts/ci-recovery/state.mjs` — added `notApplicablePattern` and
  `hasNotApplicableMarker()` export; updated `shouldResolveThread()` to also
  return `true` when the last trusted comment carries `✅ Not applicable`.
- `.github/scripts/ci-recovery/reconcile.mjs` — updated recovery instructions
  to document both valid marker formats for agents.
- `.github/scripts/ci-recovery/state.test.mjs` — added 4 regression tests.

## Systems touched

ci-recovery

## Verification Run

`npm run verify:fast` — 1260 tests pass  
`node --test .github/scripts/ci-recovery/*.test.mjs` — 241 tests pass  
`npm run verify:pr-prereqs` — passed after ledger + handoff committed

## Unresolved Issues

None.

## Recommended Next Steps

The unresolved thread on PR #1571 should now be auto-resolved by the next
CI recovery sweep since `shouldResolveThread` now accepts the `✅ Not applicable`
marker that the agent already posted.
