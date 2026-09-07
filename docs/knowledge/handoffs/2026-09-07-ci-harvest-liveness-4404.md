# CI harvest liveness incident follow-up (#4404)

**Date:** 2026-09-07
**Verdict:** Recommended
**Apples:** 3 estimated

## Systems touched

ci-policy, ci-recovery, merge-train

## Summary

Incident #4404 was **not** a failing harvest. The last reconcile run succeeded
at 03:29:58 and the next one did not start until 04:52:55; every non-success
reconcile run (including 34073228341) predates the last success, so
`consecutiveFailures` was 0. The gap is a _dispatch_ gap: `ci-liveness-sweep.yml`
is the only quiet-window dispatcher and its `schedule` triggers did not fire at
all between 01:09 and 04:52, despite a nominal 10-minute cadence.

This change does not claim to fix GitHub's cron delivery. It does two things:

- adds a deterministic regression fixture for the real timeline, so a stale
  harvest with a zero-length failure streak is provably still detected as
  `last-success-older-than-threshold`;
- makes the managed incident body name the missed scheduled sweep as the first
  thing to check when there is no failure streak, instead of sending triage into
  the PAT rate-limit playbook that does not apply to a silent dispatch gap.

## Verification

- `node --test .github/scripts/ci-recovery/harvest-liveness.test.mjs`
- `npx vitest run tests/unit/ci-liveness-sweep-workflow.test.ts tests/unit/ci-knobs-guard.test.ts`

## Runtime observation

Before: reconcile harvest runs stop after 34079815898 (success, 03:29:58) with
six PRs waiting; `ci-liveness-sweep.yml` has zero runs between 34072081286
(01:09) and 34084711620 (04:52). After: the 04:52 sweep dispatched runs
34084731976 and 34084735250, both successful, and the harvest resumed.

## Follow-up

The underlying cadence problem (GitHub delaying/dropping this repository's
scheduled workflows for hours at a time) is unfixed and is the right target for
a dedicated session — a cron-independent heartbeat, not another cron entry.
