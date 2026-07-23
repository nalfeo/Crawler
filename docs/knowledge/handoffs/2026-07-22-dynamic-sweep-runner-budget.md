# Dynamic sweep runner budget

## Date

2026-07-22

## Persona

DevOps Engineer, replacing fixed broad-sweep throttles with queue-aware shared
runner admission.

## Systems touched

ai-combat-balance, ci-policy

## Apples

3 apples estimated, 3 apples actual. The change spans three workflows, a shared
budget module, CI-recovery classification, and deterministic workflow tests.
The required separate-model plan review and bounded code-review loop are recorded
in `docs/knowledge/review-ledgers/2026-07-22-dynamic-sweep-runner-budget.review-ledger.json`.

## What changed

- Added `.github/scripts/sweep-budget.mjs`, which probes active non-sweep jobs,
  merge-train demand, and unowned CI-recovery demand; computes a sweep budget
  clamped to 1..10; fairly partitions slots among active sweeps; enriches
  matrices with `sweepSlot`; and fails closed to one slot on GitHub API errors.
- Extracted `eligibleTrainRecoveryPulls()` and
  `recoveryBacklogEntries()` from the CI Recovery Router so budgeting uses the
  full eligible backlog rather than the router's six-PR dispatch window.
- Wired AI Sweep Eval, AI Sweep Recover, and Weapon Sweep through ten
  repository-global concurrency tokens (`crawler-sweep-slot-0..9`) with
  `cancel-in-progress: false` and `queue: max`.
- Recalculate allocations at existing planning, checkpoint, selection,
  validation, and aggregation boundaries. Running shards are never cancelled.
- Replaced fixed `max-parallel: 8` values with the allocated slot count and
  added explicit read-only workflow permissions required by the probe.
- Added bounded timeouts to every budget-probe job so a stalled API request
  cannot hold a control stage for GitHub's default six-hour job timeout.

## Capacity contract

The collective broad-sweep ceiling is ten running jobs. The current budget is:

`clamp(20 - activeQueuedNonSweepJobs - latentBacklog, 1, 10)`

Latent backlog is the unique union of active merge-train entries and full
router-eligible CI-recovery PRs that lack healthy ownership. Concurrent sweeps
are ordered by run ID and receive disjoint slots while capacity permits. When
active sweeps outnumber available slots, they share slots by rank and queue
rather than dropping below the required one-slot floor.

The probe is advisory; the ten global concurrency groups are the race-safe hard
ceiling when concurrent runs inspect stale state. Control jobs also consume
slot 0, so all jobs in the three workflows participate in the same contract.

## Deterministic coverage

- `.github/scripts/sweep-budget.test.mjs` covers budget clamping, fair
  allocation, one-slot floors, backlog deduplication, job counting, matrix
  enrichment, and fail-closed API behavior.
- `.github/scripts/ci-recovery/router.test.mjs` covers full untruncated recovery
  backlog classification.
- `tests/unit/sweep-workflow-budget.test.ts` parses all three workflows and
  requires global tokens, non-cancelling maximal queues, dynamic matrix caps,
  shared probes, read-only permissions, and bounded probe timeouts.
- `tests/unit/ai-sweep-workflow.test.ts` covers the revised AI Sweep matrix
  shapes, references, and dynamic max-parallel expressions.
- `npm run verify:fast` passes with all 34 changed workflow tests.
- The Node test suites pass all 63 sweep-budget and CI-recovery tests.

## Review outcome

The initial plan used independent `max-parallel` calculations. Separate-model
plan review rejected that design because concurrent probes could race above the
collective ceiling. The implementation pivoted to ten global concurrency tokens
and recorded `plan_divergence: major_fork`.

The final code-review loop found one concrete issue: two Weapon Sweep probe jobs
lacked bounded timeouts. Those timeouts and a structural regression assertion
were added. A second complete review found no remaining concerns.

## Operational boundary

No broad sweep was dispatched from this implementation session; GitHub CI owns
the live workflow validation. Matrix plans may contain up to 200 candidates.
`strategy.max-parallel` limits dispatch to the assigned slot count before jobs
enter concurrency groups, preserving the existing candidate-coverage contract.
If GitHub scheduling behavior ever demonstrates per-group queue loss at that
scale, add explicit matrix batching rather than silently truncating candidates.
