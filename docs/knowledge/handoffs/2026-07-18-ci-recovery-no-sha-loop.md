# CI Recovery No-SHA Loop Fix

**Date:** 2026-07-18  
**Session slug:** ci-recovery-no-sha-loop  
**Apple estimate:** 1🍎

## Summary

Fixed a deterministic defect in the CI recovery automation that caused recovery loops to make no progress when a review-thread was blocked by a malformed `✅ Addressed:` marker (missing the required `in <sha>` part).

## Root Cause

The CI recovery task body in `reconcile.mjs` contained two inconsistent instructions:

- **Line 1594** (ambiguous): `...or a validated \`✅ Addressed\` result.`
- **Line 1596** (correct): `✅ Addressed in <sha>: <one-line note>`

A recovery agent read the shorter form from line 1594 and posted `"✅ Addressed: Maintainer authorization granted via CI recovery dispatch."` — omitting the required `in <sha>` part.

`extractAddressedMarkerSha` requires the regex `/✅\s*addressed\s+in\s+<?([^\s>]+)>?/i` — it needs the literal word `"in"` before the SHA. The bare `"Addressed:"` form does not match, so `shouldResolveThread` returned false and the thread was never resolved despite 2 recovery attempts.

## Files Touched

- `.github/scripts/ci-recovery/reconcile.mjs` — fixed protocol text: line 1594 now consistently says `✅ Addressed in <sha>: <one-line note>` and explicitly notes that omitting the SHA causes the reconciler to ignore the marker
- `.github/scripts/ci-recovery/state.test.mjs` — added regression tests for the no-SHA case

## Verification

- `node --test .github/scripts/ci-recovery/state.test.mjs`: 32/32 pass (was 31, +1 new regression test)
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`: 84/84 pass
- `npm run verify:fast`: passed (pre-existing unrelated failure in `epic-status.test.ts` from shallow-clone SHA not present)
- Parallel validation (code review + CodeQL): ✅ no findings

## Unresolved Issues

None.

## Recommended Next Steps

1. The fix is protocol text only — no behavioural change to `shouldResolveThread` or `extractAddressedMarkerSha`. The code already correctly rejects missing-SHA markers.
2. Consider also checking if the `ci-review-validator` agent instructions (in `.github/agents/ci-review-validator.agent.md`) need the same clarification — they may have contributed to the original malformed post.

## Systems touched

ci-recovery
