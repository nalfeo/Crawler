# Handoff: Centralize CI schedule+train gate and managed-comment markers

**Date:** 2026-07-28  
**PR:** Closes #1854  
**Epic:** #1850 CI-harness redesign  
**Apple estimate:** 3🍎 (actual: 3🍎 — exact)  

## Systems touched

ci-recovery, merge-train, ci-conflict-coordinator

## Problem solved

The `schedule && MERGE_TRAIN_ENABLED` gate was copy-pasted across ≥3 workflows, and managed-comment marker strings were scattered across 7+ files. Adding a marker was a 3-file edit; gate logic drift between copies was a latent bug source.

## What changed

### New files

**`.github/scripts/ci-recovery/markers.mjs`** — Single source of truth for all managed HTML comment marker strings (`<!-- crawler-*`). Exports named constants, the `MANAGED_COMMENT_PREFIX = '<!-- crawler-'` shared prefix, and the `MANAGED_COMMENT_MARKERS` array. Adding a new marker is now a **1-file edit**.

**`.github/actions/train-gate/action.yml`** — Composite action for the "schedule+MERGE_TRAIN_ENABLED" gate. Inputs: `event-is-schedule`, `merge-train-enabled`. Output: `enabled` (`'true'` / `'false'`). This is the single authoritative gate definition.

### Modified scripts (import/re-export pattern)

Each script file previously defined its own marker constants. They now import from `markers.mjs` and re-export under the same name (backward-compatible):

- `ci-recovery/state.mjs` — `STATE_MARKER`, `STATE_DATA_PREFIX`
- `ci-recovery/review-request.mjs` — `REVIEW_REQUEST_MARKER`, `REVIEW_CONFLICT_MARKER`
- `ci-recovery/pr-lifecycle.mjs` — `LIFECYCLE_MARKER`, `LIFECYCLE_DATA_PREFIX`
- `ci-recovery/issue-intake-lib.mjs` — `ISSUE_INTAKE_MARKER`, `ISSUE_RECOVERY_PLAN_MARKER`
- `merge-train/state.mjs` — `STATUS_MARKER` (alias for `MERGE_TRAIN_STATUS_MARKER`), `LANDED_MARKER` (alias for `MERGE_TRAIN_LANDED_MARKER`)
- `ci-conflict-coordinator/state.mjs` — `COORDINATOR_MARKER`, `COORDINATOR_DATA_PREFIX`
- `ci-recovery/router.mjs` — uses `MANAGED_COMMENT_PREFIX` for the `isManagedCommentEvent` function (no longer checks an explicit array)

### Modified workflows

**`ci-recovery-router.yml`** — Simplified 5-marker managed-comment `if:` filter to a single `!startsWith(github.event.comment.body, '<!-- crawler-')` prefix check. New markers are automatically covered.

**`ci.yml` (changes job)**:
- The temporary `train-gate` step was REMOVED during PR recovery because the scheduled `changes` job is intentionally the unconditional full-CI backstop; leaving the step in place created dead, misleading gate output without affecting control flow.

**`ci-recovery-incidents.yml` (route-incident job)**:
- Checkout is now unconditional (first step) — needed for local action resolution
- `train-gate` step is second; only the `node incident.mjs` work step is gated on train-gate output
- Removed `vars.MERGE_TRAIN_ENABLED == 'true'` from job-level `if:` (was schedule+train clause only)

**`merge-train.yml` (reconcile job)**:
- Sparse checkout (`.github/actions` only) added as first step to enable local action resolution
- `train-gate` step is second; app-token + full checkout + reconcile steps gated on output
- Removed `vars.MERGE_TRAIN_ENABLED == 'true'` from job-level `if:` schedule clause
- Full checkout (with app token) still runs when train is enabled — sparse checkout is overwritten

### Modified tests

**`router.test.mjs`** — Imports the centralized marker constants from `markers.mjs`. Updated the YAML guard test to check for the shared prefix, expanded managed-marker fixtures to cover the newly centralized incident/loop markers, and added an inventory test proving `MANAGED_COMMENT_MARKERS` covers every exported managed marker/prefix.

**`review-wake-bridge.mjs` / `review-wake-bridge.test.mjs`** — Added `.github/scripts/ci-recovery/markers.mjs` to the privileged recovery execution boundary so the immutable protected-path check stays aligned with the new import closure.

**`tests/unit/merge-train-workflow-wakeups.test.ts`** — Updated test `'reconciles a completed scheduled CI run only while the merge train is enabled'`: the job-level `if:` now admits all schedule events (gate is in the step, not the YAML condition). Added new test `'train-gate step enforces MERGE_TRAIN_ENABLED for schedule-triggered CI wakes'` that validates the step is present, wired correctly, and that checkout precedes it.

## Design decisions

1. **Prefix-based routing, not an explicit array**: `isManagedCommentEvent` and the YAML filter both use `'<!-- crawler-'` as a prefix check. New markers auto-covered; the `MANAGED_COMMENT_MARKERS` array is for tests/inventory, not routing.

2. **ci.yml schedule backstop stays unconditional**: `ci.yml` is the daily full-CI backstop, so it should not consult the train gate at all. The shared `train-gate` action remains authoritative for the workflows that truly need schedule+flag gating (`merge-train.yml` and `ci-recovery-incidents.yml`).

3. **Checkout before local composite action**: GitHub Actions requires the repo to be checked out before `uses: ./.github/actions/...` can resolve. All 3 guarded workflows have a checkout step before the `train-gate` step. For `merge-train.yml`, a sparse checkout fetches only `.github/actions` (fast, minimal data) before the gate; the full checkout happens after and overwrites it.

4. **Backward-compatible re-export pattern**: Downstream code that imports from `state.mjs`, `review-request.mjs`, etc. is unchanged. Each "home" file simply re-exports the constant it received from `markers.mjs`.

## Recovery follow-up

- PR review recovery centralized the remaining live marker literals that had been called out (`ci-incident`, `merge-train-empty-incident`, `pr-loop-incident`, and the loop-fingerprint prefix), switched `reconcile.mjs` to consume the shared merge-train/task markers at its call sites, and removed the dead `ci.yml` train-gate step.

## Apples

Estimated: 3🍎 · Actual: 3🍎 · Verdict: exact

## Observe before done

The acceptance criterion says to dispatch a guarded workflow off-schedule and confirm it no-ops via the shared gate step. This should be verified after the PR merges by dispatching `merge-train.yml` or `ci-recovery-incidents.yml` via `workflow_dispatch` with `MERGE_TRAIN_ENABLED=false` and observing the "Train gate: schedule trigger with MERGE_TRAIN_ENABLED != 'true' — skipping (no-op)." log line in the gate step. (Off-schedule dispatch uses `event-is-schedule: false` for both workflows, so the gate passes — a true off-schedule test would require waiting for a schedule trigger or manually setting `event-is-schedule: true` in the test run.)
