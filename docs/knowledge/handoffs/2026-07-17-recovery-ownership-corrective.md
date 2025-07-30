# Recovery Ownership Corrective

## Systems touched

ci-policy

## Summary

PR #1255 squash-merged as `b8f1170e23a4db2b08abfd3c2f5e190013596f51`
while its second Copilot review wave was still being validated. This non-stacked
corrective branch carries only the validated post-merge delta onto current
`origin/main`.

The corrective changes preserve a newer converged idle/waiting state when a
known stale-node 422 observes that the atomic repository owner label is already
absent, while still failing closed for a different active owner. Interrupted
stale-automation release is resumable: progress-key-scoped exhausted ownership
finishes at idle, while legacy cumulative attempt state receives its promised
single compatible retry.

Repository-label cleanup is incarnation-safe: stale-node recovery deletes only
the original label node, and ordinary release persists terminal state plus
waiting cleanup while the original repository label still fences acquisition.
The repository fence is deleted last, so a new owner cannot be overwritten by
the releasing run.

Broad sweep ownership hydration now processes oldest-first and stops only when
the fully resolved prefix contains six PRs that the real sweep policy can
dispatch. This avoids both full-backlog hydration and premature stopping on
queued, waiting, opted-out, or otherwise ineligible candidates.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `.github/scripts/ci-recovery/router.mjs`
- `.github/scripts/ci-recovery/router.test.mjs`
- `.github/scripts/ci-recovery/state.test.mjs`
- `docs/knowledge/handoffs/2026-07-17-reduce-recovery-runner-noise.md`
- `docs/knowledge/metrics/guard-telemetry/2026-07-17-reduce-recovery-runner-noise.json`
- `docs/knowledge/review-ledgers/2026-07-17-recovery-ownership-corrective.review-ledger.json`

## Additional corrective wave (PR review feedback)

Three additional ownership race conditions identified by Copilot reviewer and
validated by independent `gpt-5.6-luna` model:

1. **`isConvergedElsewhereState` accepts null**: predicate now requires
   explicit `owner === 'none'` AND `status` in `['idle','waiting']` — a
   missing state comment (null) is no longer treated as convergence.
2. **`removePrLabel` 404 treated as success**: `removePrLabel` now returns
   `null` on 404 to distinguish "already absent" from "successfully deleted";
   `release()` pre-checks `hasPrLabel` and routes 404+expected-attachment
   through `completeReleaseHandoff` as a lost release race.
3. **Fence dropped before waiting-label cleanup in `completeReleaseHandoff`**:
   converged-elsewhere branch now calls `preserveConvergedElsewhereState`
   while the claimed fence is held, then deletes by GraphQL node ID last.

Three deterministic regression tests added (83 total, all passing).

## Verification

- Focused CI Recovery Node suite: 83 passed (100% of node-native tests), 0 failed.
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- Corrective 3-apple ledger: `gpt-5.4` plan review plus a two-round
  `claude-sonnet-4.6` code-review loop ending clean.
- Additional wave validated by independent `gpt-5.6-luna` model.
- Deterministic production replay remains green: 149 Router records, 196
  Recovery jobs, 291 to 122 runner jobs (58.08% reduction), 77 identical
  effective actions, zero cleanup/stale-owner failures, exactly two expected
  stale-heartbeat failures, and 20-second modeled p95.

## Unresolved issues

Live post-merge production confirmation remains pending. The deterministic
production-model gate is green.

## Recommended next steps

Observe the next qualifying parked-review wake and the next stale-automation
timeout in production to confirm the modeled behavior against live telemetry.
