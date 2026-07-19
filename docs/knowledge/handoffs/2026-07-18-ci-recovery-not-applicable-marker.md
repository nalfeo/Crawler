# Handoff: CI Recovery — Support ✅ Not applicable Marker

**Date:** 2026-07-18  
**Session slug:** ci-recovery-not-applicable-marker  
**Apple estimate:** 2🍎

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
  to document both valid marker formats for agents and require a SHA for every
  ordinary `✅ Addressed` result.
- `.github/scripts/ci-recovery/state.test.mjs` — added 4 regression tests.
- `.github/scripts/ci-recovery/reconcile.test.mjs` — verifies the generated
  task body reserves SHA-less resolution for `✅ Not applicable: <reason>`.

## Consolidation

Compared the overlapping implementations in PRs #1612, #1606, and #1594.
This PR keeps #1612's explicit non-applicability marker, incorporates #1606's
fail-closed `✅ Addressed in <sha>` task wording, and rejects #1594's broader
bare-`✅ Addressed` fallback.

## Systems touched

ci-recovery

## Verification Run

`npm run verify:fast` — 1260 tests pass  
`node --test .github/scripts/ci-recovery/reconcile.test.mjs .github/scripts/ci-recovery/state.test.mjs` — 90 pass, 36 skipped on the known Windows subprocess shutdown assertion
`npm run verify:pr-prereqs` — passed after ledger + handoff committed

## Unresolved Issues

None.

## Recommended Next Steps

The unresolved thread on PR #1571 should now be auto-resolved by the next
CI recovery sweep since `shouldResolveThread` now accepts the `✅ Not applicable`
marker that the agent already posted.
