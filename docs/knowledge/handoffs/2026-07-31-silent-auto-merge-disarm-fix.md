# Handoff: Silent auto-merge disarm fix (issue #2453)

## Date

2026-07-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 (tooling/CI-automation only; cap applies — no runtime gameplay affected).

## Summary

Closed issue #2453: "CI: automation-driven PR head advance silently clears armed
auto-merge, creating dormant PRs with no signal."

### Root cause

When `reconcile.mjs` calls the GitHub `update-branch` API to advance a PR's
head onto current `main` (the D2 fix, ARM_AUTO_MERGE path), GitHub silently
clears any armed auto-merge on the PR.  The push event fired by the PAT
*should* eventually trigger a fresh reconcile run and re-arm, but is subject to
router backpressure and rate-limit budget.  If those fail, the PR sits
indefinitely with green-looking state and no auto-merge — indistinguishable
from a healthy PR, generating no failing check and no new event.

### Fix: three-part

**1. Post-update-branch reconcile dispatch (`reconcile.mjs`)**

After `update-branch` returns 202 (branch actually advanced), reconcile now
immediately dispatches a fresh `ci-recovery.yml` run for the same PR with
`trigger=post-update-branch`.  The new run waits for CI to pass on the new head
and then re-arms auto-merge — even if the push-event-driven path is dropped or
budget-gated by the router.

When `update-branch` returns 422 (already up-to-date), the head SHA did not
change, auto-merge was not cleared, and no dispatch is issued.

Dry-run mode emits `dry-run would-dispatch-post-update-branch pr=#N` so the
intent is visible without mutating anything.

**2. Dormant unarmed PR watchdog (`unarmed-pr-watchdog.mjs`)**

New pure module with a single export `detectUnarmedMergeablePrs(pulls)`.  A
pull request is "dormant unarmed" when ALL of these hold:

- `state === 'open'`
- `draft` is falsy
- `mergeable_state === 'clean'` (all required checks passing, up-to-date, no conflicts)
- `auto_merge` is null/undefined (not armed)
- No label in `UNARMED_WATCHDOG_BLOCKED_LABELS` (merge-train queue, human-approval,
  conflict-coordinator labels, lifecycle quarantine/abandon, ci-recovery-opt-out)

The function is O(n) over the PR list with no I/O.

**3. Liveness sweep step (`ci-liveness-sweep.yml`)**

New step "Dispatch reconcile for dormant unarmed PRs" runs after the existing
harvest-liveness check every 10 minutes:

1. Lists the 100 most-recently-updated open PRs against `main`.
2. Calls `detectUnarmedMergeablePrs` to find dormant candidates.
3. Dispatches `ci-recovery.yml reconcile` with `trigger=unarmed-watchdog` for
   each, capped at 5 per sweep window (overridable via
   `UNARMED_WATCHDOG_DISPATCH_CAP` repo variable).
4. Logs `unarmed-watchdog found=N … dispatched=M`.

This is the safety net for the general case (not just reconcile's own
update-branch) — it catches PRs disarmed by the conflict coordinator, merge
train, or any external head advance.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs` — ARM_AUTO_MERGE update-branch
  section: track 202 vs 422, dispatch `post-update-branch` reconcile on 202.
- `.github/scripts/ci-recovery/unarmed-pr-watchdog.mjs` — **new** pure module.
- `.github/scripts/ci-recovery/unarmed-pr-watchdog.test.mjs` — **new** 22 unit
  tests (all pass).
- `.github/scripts/ci-recovery/reconcile.test.mjs` — updated two existing
  update-branch tests (dry-run + live ARM_AUTO_MERGE) to assert the new
  dispatch; added new test for the 422 no-dispatch case.
- `.github/workflows/ci-liveness-sweep.yml` — new "Dispatch reconcile for
  dormant unarmed PRs" step.

## Tests

- `reconcile.test.mjs`: 161 pass, 0 fail (pre-existing `yaml` pkg failures in
  `harvest-liveness.test.mjs` and `router.test.mjs` are unrelated sandbox
  dependency issues — they pass under `npm run test:guards`).
- `unarmed-pr-watchdog.test.mjs`: 22/22 pass.

## Observe / verify

CI-automation only.  No runtime game path affected.  `npm run scope` classifies
this as `docs_only=false, gameplay_safe=true` (no src/ changes).

The watchdog step is observable in the GitHub Actions logs for
`ci-liveness-sweep.yml` runs — look for lines matching
`unarmed-watchdog found=N … dispatched=M`.

The post-update-branch dispatch is observable in `ci-recovery.yml` reconcile
run logs — look for `dispatch-post-update-branch pr=#N` after
`update-branch pr=#N reason=clean-behind`.

## Follow-up

- This does not yet address the conflict coordinator's `disableAutoMerge()`
  path.  The coordinator explicitly disables auto-merge and then dispatches
  `ci-recovery.yml reconcile`, so the loop will re-arm — but only after CI
  passes on the new head.  The unarmed-watchdog covers this gap as a safety
  net.
- Issue #2434 (no "nothing noticed" alarm) should build its full open-PR
  inventory reconciliation against `auto_merge` state, not just decision-log
  entries.  The watchdog's `detectUnarmedMergeablePrs` is directly reusable
  for that purpose.
