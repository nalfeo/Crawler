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
merge-train queue is non-empty and to 2 whenever it is empty (measured capacity
evidence: public repo, 20-job Actions concurrency limit; uncontended Validation
peaks 7-9 concurrent jobs; an AI Sweep Eval run alone peaked at ~19 concurrent,
which is what starved Validation runners), plus a bounded poll
(`waitForOutstandingCount`) that closes a TOCTOU race between dispatching a run
and it becoming visible via the Actions list-runs API.

**Post-merge correction (same PR, same day)**: the parent session flagged that
the initial cut left the dispatch budget **unbounded (`Infinity`)** whenever
`MERGE_TRAIN_ENABLED` was `false` — exactly the maintenance/rollback window
where runner-capacity protection must NOT lapse. `computeDispatchBudget` was
changed to drop the `trainEnabled` parameter entirely and always return a
finite budget (cap 1 with an active merge-train backlog, cap 2 otherwise,
including with the train feature disabled/paused). See "What changed" and
"Known residual limitation" below for the corrected behavior and the accepted
trade-off this creates.

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
  - `GLOBAL_TRAIN_DISPATCH_CAP = 1` (an active merge-train backlog — the
    incident scenario) and `GLOBAL_IDLE_TRAIN_DISPATCH_CAP = 2` (no active
    backlog — queue empty, train idle, **or the train feature disabled**).
  - `OUTSTANDING_RUN_STATUSES` now includes `pending` (a documented Actions run
    status previously omitted, which would have undercounted outstanding runs).
  - New `listWorkflowRunsByStatus` (custom pagination — the Actions "list
    workflow runs" endpoint returns `{ total_count, workflow_runs }`, not a bare
    array, so the repo's generic `paginate()` helper couldn't be reused),
    `countOutstandingRecoveryRuns`, `computeDispatchBudget` (takes only
    `trainQueueNonEmpty`/`outstandingCount` — **no `trainEnabled` parameter and
    no `Infinity` branch**: backlog non-empty → cap 1; backlog empty/absent,
    including with the train feature off → cap 2), `partitionDispatchable`,
    and `waitForOutstandingCount` (bounded poll that closes the TOCTOU race
    between a dispatch and its visibility via the Actions API — degrades to a
    logged warning on timeout rather than hanging, relying on the existing
    10-minute scheduled sweep as the eventual-consistency backstop).
  - `runFromEnv()` now **always** fetches the open-PR list, computes
    train-queue-non-empty status, and fetches the outstanding recovery-run
    count — unconditionally, not gated on `MERGE_TRAIN_ENABLED` — computes the
    budget, partitions PRs into dispatchable/deferred, dispatches only
    `dispatchable`, and waits for the dispatch(es) to become visible before the
    invocation ends and releases its concurrency slot. `trainQueueNonEmpty` is
    derived from `queueEntries()`, which itself keys off the `merge-train` PR
    label rather than the feature flag, so a stale label surviving a flag-off
    still correctly forces the stricter cap of 1 (fail closed).
- **Tests (`router.test.mjs`)**: 48 tests total, including:
  `computeDispatchBudget`/`partitionDispatchable`/`countOutstandingRecoveryRuns`
  unit tests covering the backlog-present, backlog-empty, and
  train-feature-disabled cases (the last of these is the post-merge correction
  addition, proving the cap is still 2, never `Infinity`, when
  `trainQueueNonEmpty: false` regardless of why); `waitForOutstandingCount`
  tests (observes newly-visible count, gives up after bounded attempts, and a
  composed TOCTOU-race-closing test); three burst-bound proof tests: the
  train-backlog-non-empty case (25 events → exactly 1 dispatch, cap never
  breached mid-burst), the train-idle-but-enabled case (25 events → exactly 2
  dispatches), and the new **train-feature-disabled** case (25 events →
  exactly 2 dispatches, cap never breached mid-burst) added specifically for
  this correction; workflow YAML structural tests confirming the concurrency
  group unifies correctly under train mode, `cancel-in-progress` stays `false`
  in that branch, and — the round-1 regression fix — `queue` can never resolve
  to `'max'` in the same branch where `cancel-in-progress` could resolve to
  `true`.

## Root-cause finding

`.github/workflows/ci-recovery-router.yml`'s concurrency group formula only
routed a narrow subset of event types into the shared "train" group under
`MERGE_TRAIN_ENABLED=true`; all direct PR-scoped events still got unique
per-PR concurrency groups, so N independently-triggered PR events could spawn
N fully concurrent router runs. Each run applied
`CI_RECOVERY_MAX_DISPATCH_PER_RUN` in isolation with no shared view of the
total number of CI Recovery runs already outstanding, so the effective global
dispatch rate scaled with the size of the burst instead of being bounded.

## Known residual limitation (explicitly reported, not silently accepted)

Making `computeDispatchBudget` unconditional closes the "train disabled →
unbounded dispatch" gap, but it cannot be made fully race-proof in
legacy/flag-off mode: `.github/workflows/ci-recovery-router.yml`'s concurrency
`group` only unifies into the single global `crawler-ci-recovery-router-train`
group when `MERGE_TRAIN_ENABLED == 'true'`. With the feature off, groups
remain per-PR (`crawler-ci-recovery-router-pr-{number}`) or per-sweep, so two
different-PR router invocations CAN run truly concurrently and each read the
Actions API's outstanding-run count before either dispatch becomes visible —
both could observe the same stale low count and both dispatch, momentarily
exceeding the cap of 2 by one. This was evaluated and intentionally NOT closed
by unifying concurrency groups universally, because that breaks the legacy
path's deliberate `cancel-in-progress: true` dedup semantics for `schedule`/
`workflow_dispatch` events (a pre-existing, already-reviewed design
constraint), and introducing a separate cross-invocation lock was ruled out by
the task's explicit priority to avoid new credentials/workflow-write
permissions. The mitigation is real (a live API-backed check on every
invocation, not a no-op) and bounds the worst case to a small, one-invocation
overshoot rather than the original unbounded/thundering-herd failure mode —
but it is best-effort, not airtight, against truly simultaneous different-PR
invocations specifically in flag-off mode. This mirrors the already-accepted
TOCTOU race in the serialized/train-enabled path, just with a wider (unserialized)
race window. Flagged here per the parent session's explicit instruction to
report the limitation rather than paper over it; unifying concurrency
universally (accepting the `cancel-in-progress` UX trade-off for the legacy
path) is the natural follow-up if this residual gap needs to be closed further.

## Verification run

- `node --test .github/scripts/ci-recovery/router.test.mjs`: 48/48 passing
  (up from 47, +1 for the new train-feature-disabled burst test added in the
  post-merge correction).
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
