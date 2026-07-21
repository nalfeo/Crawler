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
ALL router invocations into one global concurrency group while the train feature
is enabled (previously only a narrow event subset shared that group), with
`queue: max` scoped so bursts queue instead of being dropped, without breaking
the legacy flag-off cron/manual-dispatch path (`queue: max` cannot combine with
`cancel-in-progress: true`, which that legacy path can set); (2) a
capacity-aware dispatch budget in `router.mjs` that counts existing outstanding
CI Recovery runs before dispatching, hard-caps outstanding runs to 1 while the
merge-train queue is non-empty and to 2 while the train feature is on but its
queue is empty (measured capacity evidence: public repo, 20-job Actions
concurrency limit; uncontended Validation peaks 7-9 concurrent jobs; an AI Sweep
Eval run alone peaked at ~19 concurrent, which is what starved Validation
runners), plus a bounded poll (`waitForOutstandingCount`) that closes a TOCTOU
race between dispatching a run and it becoming visible via the Actions
list-runs API.

## Files touched

- `.github/workflows/ci-recovery-router.yml`
- `.github/scripts/ci-recovery/router.mjs`
- `.github/scripts/ci-recovery/router.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-21-ci-recovery-global-backpressure.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-21-ci-recovery-global-backpressure.md`

## What changed

- **Workflow concurrency (`ci-recovery-router.yml`)**: unified the concurrency
  group so ALL event types (direct PR events, sweeps, `workflow_run`) share
  `crawler-ci-recovery-router-train` whenever `MERGE_TRAIN_ENABLED == 'true'`
  (previously only a narrow subset of event types routed into a shared group;
  everything else got a unique per-PR group, allowing unlimited concurrent
  router runs). Added `queue: ${{ vars.MERGE_TRAIN_ENABLED == 'true' && 'max'
|| 'single' }}` — conditional, not a static `queue: max` — because GitHub
  rejects the combination of `queue: max` with `cancel-in-progress: true`, and
  the pre-existing flag-off legacy path (`MERGE_TRAIN_ENABLED` unset/false)
  intentionally sets `cancel-in-progress: true` for `schedule`/
  `workflow_dispatch` events to dedup stale sweeps. Scoping `queue: max` to the
  train branch only (where `cancel-in-progress` is always `false`) avoids
  breaking that legacy/rollback path with a workflow validation error.
- **Capacity-aware dispatch (`router.mjs`)**:
  - `GLOBAL_TRAIN_DISPATCH_CAP = 1` (train queue non-empty — the incident
    scenario) and new `GLOBAL_IDLE_TRAIN_DISPATCH_CAP = 2` (train feature on,
    queue empty — previously unbounded).
  - `OUTSTANDING_RUN_STATUSES` now includes `pending` (a documented Actions run
    status previously omitted, which would have undercounted outstanding runs).
  - New `listWorkflowRunsByStatus` (custom pagination — the Actions "list
    workflow runs" endpoint returns `{ total_count, workflow_runs }`, not a bare
    array, so the repo's generic `paginate()` helper couldn't be reused),
    `countOutstandingRecoveryRuns`, `computeDispatchBudget` (now takes
    `trainEnabled` in addition to `trainQueueNonEmpty`/`outstandingCount`: train
    off → `Infinity` (legacy per-PR mode, no serialization to enforce a global
    cap against); train on + queue empty → cap 2; train on + queue non-empty →
    cap 1), `partitionDispatchable`, and `waitForOutstandingCount` (bounded poll
    that closes the TOCTOU race between a dispatch and its visibility via the
    Actions API — degrades to a logged warning on timeout rather than hanging,
    relying on the existing 10-minute scheduled sweep as the eventual-
    consistency backstop).
  - `runFromEnv()` now computes train-queue-non-empty status, fetches the
    outstanding count whenever the train feature is enabled (regardless of
    queue emptiness), computes the budget, partitions PRs into
    dispatchable/deferred, dispatches only `dispatchable`, and waits for the
    dispatch(es) to become visible before the invocation ends and releases its
    concurrency slot.
- **Tests (`router.test.mjs`)**: 47 tests total (up from ~33 pre-change),
  including: `computeDispatchBudget`/`partitionDispatchable`/
  `countOutstandingRecoveryRuns` unit tests covering all three
  train-enabled/queue-state branches; `waitForOutstandingCount` tests
  (observes newly-visible count, gives up after bounded attempts, and a
  composed TOCTOU-race-closing test); a burst-bound proof test for the
  train-queue-non-empty case (25 events → exactly 1 dispatch, cap never
  breached mid-burst) and a matching one for the train-idle case (25 events →
  exactly 2 dispatches); workflow YAML structural tests confirming the
  concurrency group unifies correctly under train mode, `cancel-in-progress`
  stays `false` in that branch, and — the round-1 regression fix — `queue`
  can never resolve to `'max'` in the same branch where `cancel-in-progress`
  could resolve to `true`.

## Root-cause finding

`.github/workflows/ci-recovery-router.yml`'s concurrency group formula only
routed a narrow subset of event types into the shared "train" group under
`MERGE_TRAIN_ENABLED=true`; all direct PR-scoped events still got unique
per-PR concurrency groups, so N independently-triggered PR events could spawn
N fully concurrent router runs. Each run applied
`CI_RECOVERY_MAX_DISPATCH_PER_RUN` in isolation with no shared view of the
total number of CI Recovery runs already outstanding, so the effective global
dispatch rate scaled with the size of the burst instead of being bounded.

## Verification run

- `node --test .github/scripts/ci-recovery/router.test.mjs`: 47/47 passing.
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
- GitHub's concurrency queue has an operational depth cap of ~100 pending
  runs per group (noted by the plan reviewer); a burst far larger than 25
  events could still exceed that depth and cause additional runs to be
  canceled outright rather than queued. Not addressed here — out of scope for
  the declared 25-event burst success gate, and worth a separate follow-up if
  bursts of that scale become plausible.
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
