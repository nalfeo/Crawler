# Handoff: PR #1734 order-fence recovery

## Date

2026-07-21

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact — a targeted merge-train/coordinator integration fix plus focused regression coverage).

## Summary

- Recovered PR #1734's remaining strict-order review blocker by moving the final coordinator-slot decision into merge-train promotion, instead of trusting only the asynchronously written `ci-conflict-order-wait` label.
- Added a new `ciConflictOrderReasonForPromotion()` helper that recomputes the live overlapping CI cluster, ranking, and supersession proofs against the current `main` SHA and blocks any PR that is not the currently active coordinator slot.
- Hooked that verifier into `promoteExactBatch()` immediately before the GitHub merge API call, so a stale train entry now rebuilds before any merge if another PR currently owns the coordinator slot.
- Added focused regression coverage for both the slot-verifier itself and the new promotion hook.

## Files touched

- `.github/scripts/merge-train/ci-conflict-order.mjs`
- `.github/scripts/merge-train/ci-conflict-order.test.mjs`
- `.github/scripts/merge-train/reconcile-lib.mjs`
- `.github/scripts/merge-train/reconcile-promotion.test.mjs`
- `.github/scripts/merge-train/reconcile.mjs`

## Verification

- Different-model validator (`gpt-5.4`) confirmed the open thread was still valid on current HEAD and identified the remaining race as the strict-order, pre-label interleaving.
- `node --test .github/scripts/merge-train/ci-conflict-order.test.mjs .github/scripts/merge-train/reconcile-promotion.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved / next steps

- After push, reply in the exact open review thread with the post-push HEAD SHA marker.
