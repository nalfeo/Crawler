# Handoff: PR #1265 CI recovery outdated-thread convergence

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Recovered PR #1299 after review showed the prior change weakened ADR 0058's marker-gated review-thread policy. The reconcile path now stays on the original safe behavior: unresolved threads remain blockers unless a trusted `✅ Addressed in <sha>` marker validates against the current head or an ancestor.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-18-ci-recovery-pr1265-outdated-threads.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-18-ci-recovery-pr1265-outdated-threads.md`

## What changed

- Restored `reconcile.mjs` so unresolved review threads are auto-resolved only when `shouldResolveThread(...)` validates a trusted marker.
- Removed the targeted regression that had asserted unmarked outdated threads were deterministically safe to auto-resolve.
- Kept the repair scoped to the reconcile thread-resolution path and the session ledger/handoff metadata.

## Observe before done

- Before: the reverted branch state resolved every unresolved `isOutdated === true` thread before blocker construction, which could remove substantive review blockers ahead of auto-merge.
- After: the repaired reconcile path leaves unmarked outdated threads in the unresolved-thread set, so they still flow into blocker construction and escalation.

## Verification run

- `node --test --test-name-pattern "reconcile resolves only ancestor lineage markers from compare status|live reconcile resolves only a trusted backtick-wrapped current-head marker" .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-ci-recovery-pr1265-outdated-threads.review-ledger.json`

## Recommended next steps

- If a stale recovery loop recurs on PR #1265, keep unresolved outdated threads blocking and escalate with validator evidence rather than silently resolving them.
