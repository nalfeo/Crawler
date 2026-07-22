# Handoff: Raise CI Recovery dispatch caps to 5 (emergency throughput unfreeze)

## Date

2026-07-22

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Emergency change (human-authorized, minimal ceremony, admin merge) raising the two
hardcoded CI Recovery dispatch caps in `router.mjs` from 1/2 to 5/5. These constants —
not the `CI_RECOVERY_MAX_DISPATCH_PER_RUN` repo variable — are what actually bound how
many CI Recovery runs may be outstanding at once. Because CI Recovery is the merge
train's SOLE feeder (it drives PRs to convergence and applies the `merge-train` label),
pinning `GLOBAL_TRAIN_DISPATCH_CAP=1` meant a single slow PR starved the train and froze
repo-wide throughput. Raising `CI_RECOVERY_MAX_DISPATCH_PER_RUN=5` earlier was inert:
`computeDispatchBudget()` clamps the per-invocation var to these global constants.

## What changed

- `.github/scripts/ci-recovery/router.mjs`
  - `GLOBAL_TRAIN_DISPATCH_CAP` 1 → 5 (cap while the merge-train queue is non-empty).
  - `GLOBAL_IDLE_TRAIN_DISPATCH_CAP` 2 → 5 (cap when the queue is empty / train
    idle / train disabled).
  - Updated the justifying comments to record the emergency raise and point at the
    durable follow-ups (#1776 load-aware budget, #1779 promote caps to runtime vars).
- `.github/scripts/ci-recovery/router.test.mjs`
  - Updated the exact-value budget assertions, the 25-event thundering-herd burst
    totals, and the TOCTOU serialization test (now value-agnostic: pre-fills `cap-1`
    outstanding so A's single dispatch reaches the ceiling and B still defers).
  - Updated stale test titles/comments that hard-coded "to 1" / "two dispatches".

`.github/scripts/merge-train/reconcile.mjs` imports `GLOBAL_TRAIN_DISPATCH_CAP` as its
own dispatch gate, so it inherits the new value automatically (its tests pass explicit
`cap` inputs and are unaffected).

## Verification

- `node --check` on `router.mjs` and `router.test.mjs`: clean.
- `node --test .github/scripts/ci-recovery/router.test.mjs`: 54/54 passing.
- `node --test .github/scripts/merge-train/reconcile.test.mjs`: 54/54 passing (confirms
  the shared-cap consumer is unaffected).

## Tradeoff (human accepted)

5 outstanding recovery runs × ~5 CI jobs ≈ 25 concurrent jobs can exceed the ~20-job
hosted-Actions ceiling and compete with Merge Train Validation (7–9 jobs). Mitigants:
#1770 landed (far less PR-head churn), sweep-fencing reduces external contention, and
#1776 (load-aware budget) is the durable replacement. This is an intentional
throughput-over-headroom bet during a 4-day feature freeze.

## Follow-ups

- #1776 — make the dispatch throttle dynamic / load-aware (durable replacement for this
  static raise).
- #1775 — CI-fix-first then global-FIFO dispatch ordering in recovery.
- #1779 — audit all CI knobs, make them runtime-tweakable + centrally documented (would
  turn these constants into variables so a future incident needs a knob-turn, not a PR).
