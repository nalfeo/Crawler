# Handoff: CI Recovery global backpressure fix

## Date

2026-07-21

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 3🍎.

## Summary

Fixed the root cause of the 2026-07-21 CI Recovery thundering-herd incident, where
25+ independently-triggered per-PR router events each independently applied
`CI_RECOVERY_MAX_DISPATCH_PER_RUN=8` with no shared view of total outstanding
dispatches, producing 30+ queued/pending CI Recovery `workflow_dispatch` runs and
starving Merge Train Validation of runner capacity. Two-part fix: (1) serialize
ALL router invocations — in every mode, every event type — into one unconditional
static global concurrency group (`crawler-ci-recovery-router`,
`cancel-in-progress: false`, `queue: max`; no `MERGE_TRAIN_ENABLED` branching, no
per-PR/per-sweep fallback groups); (2) a capacity-aware dispatch budget in
`router.mjs` that counts existing outstanding CI Recovery runs before dispatching,
hard-caps outstanding runs to 1 while the merge-train queue is non-empty and to 2
whenever it is empty (measured capacity evidence: public repo, 20-job Actions
concurrency limit; uncontended Validation peaks 7-9 concurrent jobs; an AI Sweep
Eval run alone peaked at ~19 concurrent, which is what starved Validation runners),
plus a visibility wait (`waitForDispatchedRunsVisible`) that closes a TOCTOU race
between dispatching a run and it becoming visible via the Actions list-runs API.

**Post-merge correction (same PR, same day)**: the parent session flagged that
the initial cut left the dispatch budget **unbounded (`Infinity`)** whenever
`MERGE_TRAIN_ENABLED` was `false` — exactly the maintenance/rollback window
where runner-capacity protection must NOT lapse. `computeDispatchBudget` was
changed to drop the `trainEnabled` parameter entirely and always return a
finite budget (cap 1 with an active merge-train backlog, cap 2 otherwise,
including with the train feature disabled/paused).

**Second post-merge correction (same PR, same day)**: the parent session found
that the finite budget alone still left a residual race — the workflow
concurrency group only unified into one shared group while
`MERGE_TRAIN_ENABLED == 'true'`, so in legacy/flag-off mode different-PR router
invocations could still run truly concurrently and each read a stale
outstanding-run count before either dispatch became visible. Per the parent's
explicit instruction that safety takes priority over preserving the legacy
`cancel-in-progress: true` dedup behavior, the concurrency block was replaced
with a single **unconditional, static** global group
(`crawler-ci-recovery-router`), `cancel-in-progress: false`, and `queue: max`
— all three now static values applying to every event type in every mode, with
no `MERGE_TRAIN_ENABLED` branching left in the concurrency config. This closes
the cross-PR race entirely: it is architecturally impossible for two router
invocations to run concurrently, in any mode. See "What changed" below for the
final design.

## Files touched

- `.github/workflows/ci-recovery-router.yml`
- `.github/scripts/ci-recovery/router.mjs`
- `.github/scripts/ci-recovery/router.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-21-ci-recovery-global-backpressure.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-21-ci-recovery-global-backpressure.md`

## What changed

- **Workflow concurrency (`ci-recovery-router.yml`)**: every router
  invocation — direct PR events, sweeps, `workflow_run` completions, all of
  them, in every mode — now shares one unconditional, static concurrency
  group: `group: crawler-ci-recovery-router`, `cancel-in-progress: false`,
  `queue: max`. There is no `MERGE_TRAIN_ENABLED`-conditional branching left in
  the concurrency block, and no per-PR/per-sweep fallback groups. GitHub
  forbids combining `queue: max` with `cancel-in-progress: true`; since
  `cancel-in-progress` is a static `false`, that combination is trivially
  always valid rather than needing conditional guarding. This intentionally
  drops the legacy path's previous behavior of cancelling a stale pending
  `schedule`/`workflow_dispatch` sweep in favor of the newest one — per
  explicit instruction, safety (no dropped events, an airtight global
  serialization guarantee) takes priority over that cancellation
  optimization. The existing 10-minute scheduled sweep, plus the live
  outstanding-count check in `router.mjs`, are the eventual-consistency
  backstop for the deduplication `cancel-in-progress: true` used to provide.
- **Capacity-aware dispatch (`router.mjs`)**:
  - `GLOBAL_TRAIN_DISPATCH_CAP = 1` (an active merge-train backlog — the
    incident scenario) and `GLOBAL_IDLE_TRAIN_DISPATCH_CAP = 2` (no active
    backlog — queue empty, train idle, **or the train feature disabled**).
  - `OUTSTANDING_RUN_STATUSES` now includes `pending` (a documented Actions run
    status previously omitted, which would have undercounted outstanding runs).
  - New `listRecentOutstandingRunIds` (fetches first page of the workflow run
    history and returns outstanding run IDs — used for the pre-dispatch snapshot,
    not for counting, which uses the concurrent `total_count` approach below),
    `countOutstandingRecoveryRuns` (concurrent per-status `total_count` queries
    — O(5 requests) instead of O(total_runs/100) — previously used a full
    history paginator that would have required ~349 requests for the 34,814-run
    live workflow, exhausting the token quota and 10-minute timeout),
    `computeDispatchBudget` (takes only
    `trainQueueNonEmpty`/`outstandingCount` — **no `trainEnabled` parameter and
    no `Infinity` branch**: backlog non-empty → cap 1; backlog empty/absent,
    including with the train feature off → cap 2), `partitionDispatchable`,
    and `waitForDispatchedRunsVisible` (replaces the old aggregate-count based
    `waitForOutstandingCount` for the dispatch path; accepts a pre-dispatch ID
    snapshot so completions of pre-existing runs do not prevent convergence;
    holds the concurrency slot until `count` NEW run IDs appear or a ~8 minute
    timeout expires and rejects — failing closed rather than silently succeeding).
  - `runFromEnv()` now **always** fetches the open-PR list, computes
    train-queue-non-empty status, and fetches the outstanding recovery-run
    count — unconditionally, not gated on `MERGE_TRAIN_ENABLED` — computes the
    budget, partitions PRs into dispatchable/deferred, dispatches only
    `dispatchable`, and waits for the dispatch(es) to become visible before the
    invocation ends and releases its concurrency slot. `trainQueueNonEmpty` is
    derived from `queueEntries()`, which itself keys off the `merge-train` PR
    label rather than the feature flag, so a stale label surviving a flag-off
    still correctly forces the stricter cap of 1 (fail closed).
- **Tests (`router.test.mjs`)**: 54 tests total; **`reconcile.test.mjs`**: 52 tests total
  (4 new tests for `buildGatedDispatchRecovery`: dispatches when under cap, skips
  when at cap, skips when above cap, and verifies token/owner/repo are forwarded
  to `countRuns`). The new `router.test.mjs` tests include:
  `computeDispatchBudget`/`partitionDispatchable`/`countOutstandingRecoveryRuns`
  unit tests covering the backlog-present, backlog-empty, and
  train-feature-disabled cases (the last of these proves the cap is still 2,
  never `Infinity`, when `trainQueueNonEmpty: false` regardless of why);
  `waitForDispatchedRunsVisible` tests (observes a newly-visible run by ID,
  handles pre-existing run completions without timing out, rejects on
  timeout, and a composed TOCTOU-race-closing test); three burst-bound
  proof tests: the train-backlog-non-empty case (25 events → exactly 1
  dispatch, cap never breached mid-burst), the train-idle-but-enabled case (25
  events → exactly 2 dispatches), and the **train-feature-disabled** case (25
  events → exactly 2 dispatches, cap never breached mid-burst) — this last
  test's sequential-loop model is now also an accurate model of real router
  behavior, since every event in every mode is genuinely serialized by the
  unconditional workflow concurrency group, not just JS-budget-capped;
  workflow YAML structural tests confirming the concurrency `group` is a
  static, unconditional literal (`crawler-ci-recovery-router`), that
  `cancel-in-progress` is a static `false`, and that the `queue: max` /
  `cancel-in-progress: true` combination GitHub rejects can never occur since
  both are now static values.

## Root-cause finding

`.github/workflows/ci-recovery-router.yml`'s concurrency group formula only
routed a narrow subset of event types into the shared "train" group under
`MERGE_TRAIN_ENABLED=true`; all direct PR-scoped events still got unique
per-PR concurrency groups, so N independently-triggered PR events could spawn
N fully concurrent router runs. Each run applied
`CI_RECOVERY_MAX_DISPATCH_PER_RUN` in isolation with no shared view of the
total number of CI Recovery runs already outstanding, so the effective global
dispatch rate scaled with the size of the burst instead of being bounded. An
initial fix unified the group only while the train feature was enabled,
leaving a narrower version of the same problem in legacy/flag-off mode; the
final design (below) closes this for every mode by making the group
unconditional.

## Verification run

- `node --test .github/scripts/ci-recovery/router.test.mjs`: 54/54 passing.
- `node --test .github/scripts/merge-train/reconcile.test.mjs`: 52/52 passing (4 new `buildGatedDispatchRecovery` tests).
- `npm run lint`: clean.
- `npm run verify:fast`: passed.
- `npm run test:guards`: 1273 tests; 6 pre-existing failures confirmed via
  `git stash` comparison to exist identically on the base branch
  (Windows path-resolution issues in `scripts/agent/preflight-lib.test.mjs`,
  unrelated to this change).
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-21-ci-recovery-global-backpressure.review-ledger.json`:
  valid 3-apple ledger (`plan_review`, `code_review` both recorded).
- Review harness: separate-model plan review (`gpt-5.4`, `plan_divergence:
minor`, 2 concerns raised and resolved before implementation was finalized:
  missing `queue: max` and the TOCTOU race). Code-review loop: round 1 found 1
  blocking issue (`queue: max` unconditionally combined with a
  `cancel-in-progress` expression that can be `true` in the legacy flag-off
  path — GitHub rejects that combination, which would have broken the
  10-minute cron sweep and manual `workflow_dispatch` runs whenever
  `MERGE_TRAIN_ENABLED` is unset/false, i.e. the default/rollback state) plus 3
  non-blocking notes; all were addressed (or explicitly accepted as an
  out-of-scope trade-off, in the case of `runFromEnv` lacking an end-to-end
  test — a pre-existing gap, not a regression) and round 2 confirmed clean.

## Unresolved issues

- `runFromEnv()` itself is not covered by an end-to-end test (it reads
  `process.env`/an event-payload file and calls `request`/`paginate` from
  `./github.mjs` directly rather than as injectable parameters). This is a
  pre-existing gap in this test file (no test called `runFromEnv` before this
  change either), accepted as out of scope for this incident-response-sized
  fix by both code-review rounds. The new pure-helper tests, including a
  composed TOCTOU test that calls the same functions in the same sequence
  `runFromEnv` does, cover the new logic's correctness; they don't prove the
  wiring inside `runFromEnv` itself is correct end-to-end.
- **reconcile.mjs bypass (now partially addressed)**: `merge-train/reconcile.mjs`'s
  four `dispatchRecovery()` call sites (~517, ~590, ~665, ~798) now go through
  `buildGatedDispatchRecovery` (exported from `reconcile-lib.mjs`), which applies
  `GLOBAL_TRAIN_DISPATCH_CAP` before each dispatch — the same cap used by the
  router. A narrow race window still exists between each caller's
  `countOutstandingRecoveryRuns` read and its POST: the router's concurrency
  group serialises its own invocations but cannot serialise against a concurrent
  `reconcile.mjs` run. A durable reservation (e.g. a shared semaphore via a
  repository variable) is the required follow-up to close that gap completely.
- GitHub's concurrency queue has an operational depth cap of ~100 pending runs
  per group (noted by the plan reviewer). This is more consequential now that
  every router event in every mode shares one global group: a burst far
  larger than 25 events across ALL event types (PR events, comments, sweeps,
  `workflow_run` completions) could exceed that depth and cause additional
  runs to be canceled outright rather than queued. Not addressed here — out
  of scope for the declared 25-event burst success gate — but flagged as the
  main trade-off of moving from several isolated per-mode groups to one
  universal group, worth monitoring and a candidate follow-up if sustained
  event rates approach that depth.
- Sweep isolation / max-parallel limits for other workflows (e.g. AI Sweep
  Eval, which was observed peaking at ~19 concurrent jobs and directly
  contributing to the original starvation) are explicitly out of scope for
  this PR per the parent session's instructions — a separate follow-up.

## Recommended next steps

- Once this PR merges and the incident is confirmed resolved, the parent
  session's temporary operational mitigations (repository variable
  `CI_RECOVERY_MAX_DISPATCH_PER_RUN=1`, paused feature PRs with
  `ci-recovery-opt-out`, disabled Auto-rebase) can be reverted, since the
  structural fix here makes that per-run cap redundant for burst protection
  (though it can safely remain at its normal default `8` since the global cap
  in `router.mjs` now dominates while the train is active).
- Consider a follow-up to add sweep-workflow isolation/`max-parallel` limits
  (e.g. AI Sweep Eval) as a second layer of runner-capacity protection,
  since that workflow alone can still consume most of the repo's 20-job
  Actions concurrency budget even with CI Recovery fully backpressured.
