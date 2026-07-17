# Reduce CI Recovery runner noise

## Date

2026-07-17

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3 apples, actual 3 apples. The work stayed inside the existing CI
Recovery state machine, Router, workflow triggers, and deterministic tests.

## What changed

- Made merge-train admission edge-triggered. Only an absent-to-present queue
  transition dispatches a broad Router fill wake; clean reconciliation of an
  already queued PR no longer recursively fans out.
- Removed the non-actionable `workflow_run: requested` Router trigger while
  retaining `completed` and exact direct-PR routing.
- Made broad sweeps hydrate owner state in bounded ordered batches, skip healthy
  active owners, include stale or inconsistent owners, and continue scanning
  until six dispatchable PRs are found.
- Ordered ownership release so the PR label is detached before the repository
  label definition is deleted. The known stale-node 422 path refetches all
  ownership facts, retries once only for the exact same persisted ownership
  incarnation, and proves the atomic owner bit absent before terminal state is
  written. Unknown 422s and generic non-404 failures remain fail-closed.
- Added explicit automation progress metadata. A stalled task retries once after
  30 minutes with its attempt and progress identity preserved; a second stall
  releases to idle without a waiting marker so the next independent wake may
  assign a new agent.
- Added an anonymized deterministic replay of the observed one-hour production
  trace and regressions for release ordering, stale-owner recovery, queue-edge
  dispatch, sweep selection, and stale automation transactions.

## Deterministic production-model gate

- Input: 149 Router records and 196 CI Recovery jobs.
- Effective PR actions: identical before and after.
- Runner jobs: 291 to 122, a 58.08% reduction.
- Recovery outcomes: 191 success / 5 failure to 80 success / 2 failure.
- Expected stale-heartbeat mismatches retained: exactly 2.
- Cleanup-race failures: 3 to 0.
- Stale-owner failures: 1 to 0.
- Modeled p95 wake-to-reconcile latency: 39 seconds to 20 seconds, below the
  approved 60-second ceiling.

## Preserved invariants

- PR #1227 expected-head/base trust fences, per-mutation metadata checks,
  one-sided ownership repair, and trusted parked-review wake bridge remain.
- PR #1229 durable waiting and waiting-transition semantics remain.
- PR #1230 exact direct-routing hygiene remains.
- CI Recovery retains `concurrency.queue: max`; active shepherd leases and stale
  lease-ID heartbeat rejection are unchanged.

## Observe before done

- Before: repeated clean queue admission dispatched recursive broad fill wakes;
  release concurrently deleted the PR and repository labels; unchanged
  automation ownership could remain dispatched for hours.
- After: the replay and mocked GitHub API harness show one queue-edge wake,
  ordered fail-closed release, one bounded stale-task retry, and exhausted
  release to unowned idle.
- Real artifact: `.github/scripts/ci-recovery/reconcile.mjs` and
  `.github/scripts/ci-recovery/router.mjs` executed through the subprocess mock
  GitHub API harness; the production model executed through
  `.github/scripts/ci-recovery/trace-replay.mjs`.

## Verification

- Focused state/router/reconcile/replay Node suite: 91 passed, 51 skipped by the
  documented Windows subprocess exemption, 0 failed. Linux CI remains
  authoritative for skipped subprocess cases.
- Recovery workflow bridge/wiring Vitest suite: 9 passed.
- `npm run verify:fast`
- Review ledger validation
- Review harness: `gpt-5.4` plan review with minor divergence; two code-review
  rounds resolved one transaction-coverage concern, one ownership-incarnation
  race, and one latency-indexing defect. Focused final validation was clean.

## Production status

The deterministic production-model gate is green. Live post-merge production
confirmation remains pending; the registered review-wake bridge has only seen
expected skip-only non-qualifying completions so far.
