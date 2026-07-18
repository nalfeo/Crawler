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

Investigated CI Recovery incident #1296 for PR #1265 and found a deterministic convergence gap in the review-thread resolution path: unresolved threads marked `isOutdated: true` were still treated as hard blockers unless they also carried a trusted `✅ Addressed in <sha>` marker. In this incident, outdated threads remained unresolved across attempts, fingerprint stayed unchanged, and the stale-automation path exhausted at attempt 2.

The fix now auto-resolves unresolved outdated threads as deterministic non-applicability and emits an explicit reason in reconciliation logs.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-18-ci-recovery-pr1265-outdated-threads.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-18-ci-recovery-pr1265-outdated-threads.md`

## What changed

- Updated thread-resolution filter in reconcile to resolve unresolved threads when either:
  - trusted marker points at current head/ancestor (existing behavior), or
  - thread is flagged `isOutdated === true` (new deterministic non-applicability path).
- Added `reason=` to resolve logs (`trusted-marker` vs `deterministic-non-applicable-outdated`) for operator clarity.
- Added a focused reconcile regression proving only outdated unresolved threads auto-resolve while active unresolved threads remain open.

## Observe before done

- Before: incident run `29622391533` shows stale automation release after attempt 2 (`released stale automation pr=#1265 attempts=2`) with review-thread blockers unchanged.
- After: dry-run reconcile test emits `would-resolve thread=<outdated-id> reason=deterministic-non-applicable-outdated` and does not resolve non-outdated unresolved threads.

## Verification run

- `node --test --test-name-pattern "reconcile resolves only ancestor lineage markers from compare status|live reconcile resolves only a trusted backtick-wrapped current-head marker|reconcile auto-resolves unresolved outdated threads as deterministic non-applicable" .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-ci-recovery-pr1265-outdated-threads.review-ledger.json`

## Unresolved issues

- Could not post the required pre-code issue plan comment to #1296 from this environment because GitHub write API calls are blocked by the DNS monitoring proxy (`HTTP 403: Blocked by DNS monitoring proxy`).

## Recommended next steps

- Re-run CI Recovery against PR #1265 and confirm outdated review threads no longer persist as blockers across stale retries.
