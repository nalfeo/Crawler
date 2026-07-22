# CI Configuration Knobs

Canonical reference for every runtime-tweakable CI knob across the CI Recovery,
Merge Train, and CI Conflict Coordinator automation.

**Operational rule**: no behavior-shaping value requires a code change + PR to adjust.
All operationally-meaningful knobs are settable via GitHub Actions repository variables
(Settings → Secrets and variables → Actions → Variables) with safe in-code defaults.

> See also: [`docs/guides/ci-recovery.md`](../../guides/ci-recovery.md),
> [`docs/guides/merge-train.md`](../../guides/merge-train.md)

---

## Runtime-tweakable knobs

### Dispatch caps (CI Recovery ↔ Merge Train backpressure)

| Variable | Default | Safe range | Scope | Effect |
|---|---|---|---|---|
| `CI_GLOBAL_TRAIN_DISPATCH_CAP` | `5` | 1–10 | Router + Reconcile | Max outstanding CI Recovery runs while the merge-train queue is non-empty. Raising this allows more PRs to converge in parallel; lowering it reserves more runner capacity for Merge Train Validation. **This is the knob that was silently inert during the 2026-07-22 incident** — it now takes effect immediately via repo variable. |
| `CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP` | `5` | 1–20 | Router only | Max outstanding CI Recovery runs when the merge-train queue is empty, the train feature is idle, or the train is disabled/paused. Kept non-infinite because AI Sweep Eval jobs can peak at ~19 concurrent jobs on GitHub Free. |
| `CI_RECOVERY_MAX_DISPATCH_PER_RUN` | `8` | 1–20 | Router only | Max number of CI Recovery dispatches in a **single router invocation** (before the global budget check). Lowering this reduces per-event bursts; the global cap still applies afterward. |

**Critical interaction — clamp chain**:

```
per-invocation limit: CI_RECOVERY_MAX_DISPATCH_PER_RUN  (applied first)
          ↓ then clamped by global budget
global cap (train queue non-empty): CI_GLOBAL_TRAIN_DISPATCH_CAP
global cap (train queue empty):     CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP
```

A router run can dispatch at most `min(CI_RECOVERY_MAX_DISPATCH_PER_RUN, budget)` runs where
`budget = cap - outstandingCount`. During the 2026-07-22 incident, raising
`CI_RECOVERY_MAX_DISPATCH_PER_RUN` from 1 → 5 was **silently inert** because
`GLOBAL_TRAIN_DISPATCH_CAP` (then hardcoded to 1) clamped the effective budget to 0 when even
one CI Recovery run was already outstanding. Both caps are now env-driven so either adjustment
takes effect without a code change.

**Log line**: when backpressure defers PRs, the router now emits:
```
global backpressure applied deferred=N pr_numbers=... outstanding=K budget=B cap=C
```
`budget` is the **effective** remaining capacity (cap minus outstanding); `cap` is the active cap
for this invocation.

---

### CI Recovery behavior

| Variable | Default | Effect | Scope |
|---|---|---|---|
| `CI_RECOVERY_MODE` | `dry-run` | `dry-run` logs without mutating; `live` enables all mutations (auto-merge, thread replies, label changes, task dispatch). Set to `live` after validating dry-run output. | `ci-recovery.yml` |
| `MERGE_TRAIN_ENABLED` | `false` | When `true`, CI Recovery works up to 6 oldest non-ready PRs, enqueues converged immutable heads for the train, and switches auto-rebase to train-aware mode. When `false`, legacy auto-merge and blanket rebase behavior applies. | Router, Reconcile, CI, Auto-rebase |
| `MERGE_TRAIN_ADMISSION_CHECKS` | `ci,Security checks` | Comma-separated list of check names that must be green before a PR is admitted to the merge train. | `ci-recovery.yml`, `merge-train.yml`, `ci-conflict-coordinator.yml` |
| `CI_CONFLICT_REOPEN_RETRY_DELAY_MS` | `500` | Base delay in milliseconds between PR-reopen retry attempts in the CI Conflict Coordinator. | `ci-conflict-coordinator.yml` |

---

### Merge train / auto-rebase

| Variable | Default | Effect | Scope |
|---|---|---|---|
| `MERGE_QUEUE_ENABLED` | _(unset / falsy)_ | When truthy, allows `auto-rebase-prs.yml` to run even if `MERGE_TRAIN_ENABLED` is false (legacy GitHub Merge Queue mode). **Keep unset** unless explicitly using GitHub's native merge queue. | `auto-rebase-prs.yml` |

---

## Vestigial / deprecated knobs

| Variable | Status | Action required |
|---|---|---|
| `MERGE_TRAIN_MODE` | **Vestigial — read by zero code.** The repo variable may still exist. | Delete this repo variable from Settings → Secrets and variables → Actions → Variables. No code references it; the variable is a misleading phantom. |

---

## Structural constants (not operationally tweakable)

These are hardcoded in the CI scripts and are intentionally not env-driven. They
are listed here for completeness and so that reviewers can distinguish "this value
is deliberately fixed" from "this value was missed."

| Constant | File | Value | Rationale |
|---|---|---|---|
| `REPAIR_WINDOW_SIZE` | `router.mjs` | `6` | Max PRs included in a repair-window sweep. Matches the 6-PR merge train batch size. |
| `OWNERSHIP_HYDRATION_BATCH_SIZE` | `router.mjs` | `6` | GitHub API concurrency for ownership hydration. |
| `DEFAULT_RETRY_MAX_ATTEMPTS` | `router.mjs` | `6` | Max retries for rate-limit / transient API failures. |
| `DEFAULT_RETRY_BASE_DELAY_MS` | `router.mjs` | `1000` | Retry back-off base delay. |
| `DEFAULT_RETRY_MAX_DELAY_MS` | `router.mjs` | `30000` | Retry back-off ceiling. |
| `FLAG_OFF_SWEEP_ROTATION_WINDOW_MS` | `router.mjs` | `600000` (10 min) | Rotation window for flag-off sweep ordering. |
| `DEFAULT_OUTSTANDING_VISIBILITY_TIMEOUT_MS` | `router.mjs` | `480000` (8 min) | Timeout for post-dispatch run-visibility wait. |
| `DEFAULT_OUTSTANDING_VISIBILITY_POLL_INTERVAL_MS` | `router.mjs` | `5000` | Poll interval for run-visibility wait. |
| `MIN_CLUSTER_SIZE` | `ci-conflict-coordinator/state.mjs` | `3` | Minimum PR count for a conflict-coordination cluster. |
| `MAX_OVERLAP_FILES` | `ci-conflict-coordinator/state.mjs` | `20` | Max overlap files stored/shown per cluster (GitHub comment size cap). |
| `DISPATCH_LEASE_MS` | `ci-conflict-coordinator/state.mjs` | `1800000` (30 min) | How long a coordinator dispatch lease is considered live. |
| `REBASE_FAILURE_MAX_ATTEMPTS` | `ci-recovery/reconcile.mjs` | `3` | Max rebase-failure retries. |
| `REBASE_FAILURE_BASE_BACKOFF_MS` | `ci-recovery/reconcile.mjs` | `60000` | Rebase-failure back-off base. |
| `REBASE_FAILURE_MAX_BACKOFF_MS` | `ci-recovery/reconcile.mjs` | `600000` | Rebase-failure back-off ceiling. |
| `RELEASE_HANDOFF_ATTEMPTS` | `ci-recovery/reconcile.mjs` | `3` | Max handoff-retry attempts. |
| `RELEASE_HANDOFF_DELAY_MS` | `ci-recovery/reconcile.mjs` | `100` | Delay between handoff-retry attempts. |
| `MAIN_HEALTH_PUSH_RUN_LOOKBACK` | `merge-train/reconcile.mjs` | `5` | How many recent push-triggered CI runs to inspect when checking main-branch health. |
| `MAX_REOPEN_ATTEMPTS` | `ci-conflict-coordinator/reconcile.mjs` | `3` | Max PR-reopen attempts. |

---

## Deterministic guard

`tests/unit/ci-knobs-guard.test.ts` enforces this doc stays current. It:

1. Scans `.github/scripts/ci-recovery/router.mjs`, `.github/scripts/merge-train/reconcile.mjs`,
   and `.github/scripts/ci-conflict-coordinator/reconcile.mjs` for file-scope numeric constant
   declarations (`const NAME = <number>`).
2. Requires each to appear in either the **operationally-tweakable** registry or the
   **structural constants** allowlist above.
3. Fails CI if a new behavior-shaping constant is added without a doc entry.

To add a new knob:
- If operationally tweakable: add a `process.env.YOUR_VAR` read in the script, wire
  `${{ vars.YOUR_VAR || 'default' }}` in the relevant workflow YAML, and add a row to the
  runtime-tweakable table above.
- If structural: add a row to the structural constants table above.
- Then update the allowlist in `tests/unit/ci-knobs-guard.test.ts`.
