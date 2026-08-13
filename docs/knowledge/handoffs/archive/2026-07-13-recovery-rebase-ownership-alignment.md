# Session Handoff: CI recovery rebase ownership alignment and router hardening

## Date

2026-07-13

## Persona

Producer

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

### Rebase ownership alignment

Updated CI recovery blocker generation so it only emits a `merge-conflict` blocker for truly non-mergeable/dirty PRs and no longer emits a generic `rebase` blocker for branches that are only behind `main`. Updated the recovery task prompt ordering text to start with merge-conflict resolution. Added a merge-queue guard to `auto-rebase-prs.yml` so the workflow cleanly no-ops when `MERGE_QUEUE_ENABLED` is enabled. Observed in the real CI recovery artifact path (`.github/scripts/ci-recovery/reconcile.mjs` task template) that before the task explicitly requested `conflict/rebase`, and after the change it requests `merge-conflict resolution`.

### Router hardening

Added bounded retry with exponential backoff + jitter for retryable GitHub API failures (`403` rate-limit variants, `429`, `5xx`). The `requestWithBackoff` helper honours `retry-after` and `x-ratelimit-reset` response headers, capping delay at `DEFAULT_RETRY_MAX_DELAY_MS` (30 s) with up to 6 attempts.

Added a per-sweep dispatch cap (`CI_RECOVERY_MAX_DISPATCH_PER_RUN`, default `8`) in `router.mjs`. When the sweep produces more eligible PRs than the cap, the first N PRs in API fetch order (`updated desc`) are dispatched; numeric sorting was explicitly removed to prevent starvation of higher-numbered PRs.

Added workflow-level concurrency coalescing in `ci-recovery-router.yml`: event-driven runs are scoped to the triggering PR/issue/workflow-run so they cannot cancel each other; scheduled/dispatch sweeps share a single coalescing group with `cancel-in-progress: true` so back-to-back sweep triggers coalesce safely.

## Key Decisions Made

- Keep two workflows, but make rebase ownership explicit: routine behind-main rebases stay with `auto-rebase-prs`; CI recovery is conflict-first and does not ask for routine rebases.
- Gate force-rebase automation behind merge-queue mode via repo variable to prevent competing branch-update behavior when merge queue is in control.
- Preserve API fetch order (`updated desc`) for sweep dispatch priority so recently-updated PRs are served first; cap prevents runaway fan-out under queue storms.
- Event-driven router runs are scoped by PR to avoid cross-PR cancellation; sweeps coalesce so only the latest trigger matters.

## What's Next / Blockers

Monitor a few CI recovery cycles after merge to confirm prompt quality and takeover behavior on behind-only PRs. If needed, add a follow-up that makes auto-rebase lease-aware against CI-owner labels to reduce unnecessary churn even further.

## Retrospective

### Lessons Learned

The exact recovery prompt text is emitted from `reconcile.mjs`; checking `main` directly was necessary because branch drift hid the source during earlier local searches.

### Mistakes Made

I initially diagnosed lease behavior too shallowly and missed that the existing CI recovery state machine already had 30-minute lease-expiry semantics in `state.mjs`.

### Opportunities for Future Improvement

Add a focused unit/integration test asserting that behind-only PRs do not produce a `rebase` blocker in CI recovery, so this ownership boundary cannot regress silently.
