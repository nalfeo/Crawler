# Session Handoff: Load-aware CI Recovery dispatch budget

## Date

2026-07-22

## Persona

Producer

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

Replaced the two static hardcoded dispatch-cap constants in
`.github/scripts/ci-recovery/router.mjs` with a load-aware budget formula
that measures live runner pressure before deciding how many CI Recovery runs
to dispatch.

**Root cause fixed:** `GLOBAL_TRAIN_DISPATCH_CAP = 1` pinned recovery to a
single concurrent run whenever the merge-train queue was non-empty, rendering
the `CI_RECOVERY_MAX_DISPATCH_PER_RUN` repo variable nearly useless. The
feeder was starved 1-at-a-time exactly when the queue was filling.

**Key changes (all in `.github/scripts/ci-recovery/`):**

1. **New exported constants** (`router.mjs` L30-62):
   - `RUNNER_CEILING = 20` (GitHub Free hosted-job ceiling)
   - `VALIDATION_RESERVED_TRAIN_BUSY = 9`, `VALIDATION_RESERVED_TRAIN_IDLE = 3` (per-state reserved slots for Merge Train Validation)
   - `MAX_DISPATCH_BUDGET_TRAIN_BUSY = 5`, `MAX_DISPATCH_BUDGET_TRAIN_IDLE = 8` (per-state dispatch caps)
   - `SWEEP_RUNNER_WEIGHT = 10`, `VALIDATION_RUNNER_WEIGHT = 9` (estimated jobs-per-workflow-run multipliers)
   - `SWEEP_WORKFLOW_FILES`, `VALIDATION_WORKFLOW_FILE` (workflow file names for pressure measurement)
   - `GLOBAL_TRAIN_DISPATCH_CAP` / `GLOBAL_IDLE_TRAIN_DISPATCH_CAP` kept as re-exports (raised: 1→5, 2→8) for backward-compat with `reconcile.mjs`

2. **New generic `countOutstandingWorkflowRuns`** — accepts any workflow file + status subset; `countOutstandingRecoveryRuns` now delegates to it.

3. **Updated `computeDispatchBudget`** — new formula:
   ```
   validationReserved = max(VALIDATION_RESERVED_TRAIN_{BUSY|IDLE}, activeValidationJobs)
   headroom = RUNNER_CEILING − validationReserved − activeSweepJobs − outstandingCount
   budget = clamp(headroom, 0, MAX_DISPATCH_BUDGET_TRAIN_{BUSY|IDLE})
   ```
   New optional params `activeSweepJobs` and `activeValidationJobs` default to 0 for backward compat.

4. **Updated `runFromEnv`** — measures in-progress sweep runs across `SWEEP_WORKFLOW_FILES` (× `SWEEP_RUNNER_WEIGHT`) and all outstanding validation runs (× `VALIDATION_RUNNER_WEIGHT`) in parallel, passes both to `computeDispatchBudget`.

5. **Fixed dispatch log lines** — both log lines now print `budget=`, `sweep_runs=`, `validation_runs=` instead of the misleading old `cap=${maxDispatchPerRun}`.

6. **`reconcile.mjs` inherits raised cap automatically** — no code change needed; its import of `GLOBAL_TRAIN_DISPATCH_CAP` picks up the new value (5 instead of 1).

7. **New unit tests in `router.test.mjs`**:
   - `countOutstandingWorkflowRuns queries a custom workflow file with a subset of statuses`
   - `computeDispatchBudget: idle scenario`
   - `computeDispatchBudget: train-busy scenario`
   - `computeDispatchBudget: sweep-saturated`
   - `computeDispatchBudget: validation-in-flight`
   - `computeDispatchBudget: combined load`

Runtime observation: This is pure CI tooling (`.github/scripts/`); there is no game runtime to observe. The guard: existing `router.test.mjs` tests validate the budget formula; CI runs the full test suite.

## Key Decisions Made

**Sweep job counting uses `in_progress`-only:** Queued/waiting sweep runs have not yet spawned their matrix jobs so do not occupy runner slots. Using `in_progress` avoids over-counting. Each in-progress sweep is multiplied by `SWEEP_RUNNER_WEIGHT=10` as a conservative mid-point of the measured 10–19 job fan-out.

**Validation runs use the full outstanding status set:** A queued or waiting Merge Train Validation run still represents a reserved future slot; counting it protects head-of-line validation from being crowded out.

**Backward compatibility via re-exports:** `GLOBAL_TRAIN_DISPATCH_CAP` and `GLOBAL_IDLE_TRAIN_DISPATCH_CAP` are kept as re-exports equal to `MAX_DISPATCH_BUDGET_TRAIN_BUSY` and `MAX_DISPATCH_BUDGET_TRAIN_IDLE` respectively. This avoids any change to `reconcile.mjs` while giving it the raised caps immediately.

**`computeDispatchBudget` backward compat:** Old test callers that pass only `{trainQueueNonEmpty, outstandingCount}` get `activeSweepJobs=0` and `activeValidationJobs=0` by default; budget is now formula-derived rather than the old static cap.

## What's Next / Blockers

- Monitor the merge-train feeder after this lands: the budget should now reach 5 under train-busy conditions (vs. the previous cap of 1), substantially improving throughput.
- If the merge-train feeder is still stalled under peak sweep load, consider raising `SWEEP_RUNNER_WEIGHT` or `VALIDATION_RESERVED_TRAIN_BUSY` based on observed peak concurrency.
- A durable reservation (shared semaphore via repository variable) between `router.mjs` and `reconcile.mjs` would fully close the remaining narrow TOCTOU race window.

## Retrospective

### Lessons Learned

- The misleading `cap=${maxDispatchPerRun}` log line had been hiding the true cause of the feeder stall for a long time — effective budget vs. configured cap are very different numbers when global backpressure is applied.
- Raising `GLOBAL_TRAIN_DISPATCH_CAP` (1→5) as a derived constant rather than a separate code change keeps `reconcile.mjs` up-to-date for free.

### Mistakes Made

- None that required rework in this session.

### Opportunities for Future Improvement

- Wire a durable semaphore or last-dispatch-time variable to fully close the TOCTOU window between `router.mjs` and `reconcile.mjs`.
- Add an observable metric for `budget=` / `sweep_runs=` / `validation_runs=` to a Datadog/GitHub dashboard so tuning the constants becomes data-driven.
