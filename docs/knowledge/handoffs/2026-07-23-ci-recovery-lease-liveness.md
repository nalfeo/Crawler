# Handoff: CI recovery lease liveness (blocker fingerprint url-churn)

## Date

2026-07-23

## Persona

Producer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual.

## Summary

Fixes a production liveness bug reported live on PR #1809: `blockerFingerprint()` in
`.github/scripts/ci-recovery/state.mjs` hashed a blocker's `url` field. For
`ci-failure`/`ci-retrigger` blockers, `url` is a GitHub check-run/workflow-run permalink
that embeds a fresh run/job ID on **every rerun of the identical check** — including
retries dispatched by CI Recovery's own automation. `automationStallAction()` reads any
fingerprint change as `'progressed'`: it resets `attempt` to 0 and refreshes `progressAt`
on every cycle, so the stale-retry ceiling (`attempt >= 2`) and lease-reaper takeover
window could never be reached — an effectively **immortal** automation ownership lock,
even when nothing about the underlying blocker had actually changed.

**Fix:** exclude `url` from the fingerprint hash, mirroring the pre-existing `line`
exclusion (`line` is diff-position display metadata that also drifts without semantic
change). `normalizeBlockers()` still preserves the live `url` in the persisted state for
display/evidence purposes — only the _fingerprint_ ignores it.

**Live incident confirmation (mid-session):** the PR #1809 owner reported the exact root
cause of their specific cycle: CI Recovery's own dispatched Copilot cloud-agent run kept
failing at `session.create` with `Model "claude-sonnet-4.5" is not available`, surfaced
to GitHub as a check-run named `copilot` concluding `failure` — a new run/job URL each
retry (10:09 / 10:44 / 11:29 UTC). Investigated whether this needed a distinct fix
(e.g. configuring an available model, or excluding CI Recovery's own dispatch check from
blocker classification): **no model is configured anywhere in this repo's CI-recovery
code** — `reconcile.mjs`'s Copilot dispatch is a plain GraphQL assignee mutation with no
model parameter; model selection is entirely GitHub-platform-side and not something this
repo controls. Confirmed `reconcile.mjs` only derives a blocker's `id`/`summary` from
`check.name` + `check.conclusion` (never the check's own output/summary text), so this
specific incident is exactly the same fingerprint-churn class already fixed here: stable
`id`/`summary`, churning `url`. The existing regression tests already modeled this
scenario (check name `copilot`, conclusion `failure`, changing url); added explanatory
comments cross-referencing the live incident details for traceability. No additional
production-code change was needed or made for this specific report.

## Verification

- `state.test.mjs`: 43/43 pass, including a new `ci-retrigger` URL-drift test added per
  plan-review feedback (the `action_required`/parked-workflow blocker path is also
  affected and also fixed by the same central exclusion).
- `reconcile.test.mjs`: 125 tests total (113 pass, 12 skipped [pre-existing/environment],
  0 fail), including 2 new end-to-end integration tests reproducing the full PR #1809
  production cycle through `reconcile.mjs` against a mock GitHub server: cycle 2/3 (same
  check reruns with only the url changed → stays on `stale-automation-retry`, attempt
  1→2, displayed url refreshed to latest) and cycle 3/3 (ceiling reached → releases
  ownership via `stale-automation-exhausted`, files a loop incident, deletes the owner
  label — proving takeover-eligibility, not immortality).
- Non-vacuous mutation-proof: stashed the `state.mjs` fix and confirmed all new unit and
  integration tests fail with the exact bug symptom (fingerprint changes on url-only
  drift; no `stale-automation-retry` ever fires; "assigned copilot" instead of "released
  stale automation"), then restored the fix and reconfirmed all tests pass.
- Fixed an unrelated mock-server bug discovered while writing the integration tests:
  label existence (`GET .../labels/{LABEL}`) wasn't stateful, causing a false
  `"owner label was recreated during release"` failure on the release path. Added a
  `repositoryLabelExists` flag toggled by DELETE/POST label routes (existing pattern
  elsewhere in the suite).
- `npm run verify:fast`: passed.
- Real-artifact note: this is CI-automation script code
  (`.github/scripts/ci-recovery/`), not a game system — the authoritative artifact is
  the ci-recovery reconcile workflow plus the subprocess-level regression tests that
  spawn `reconcile.mjs` against a mock GitHub server, not a lab.

## Review harness

- Plan review (`gpt-5.4`, separate model): `approved_with_changes`, no blocking issues.
  `plan_divergence=minor`. 3 alternatives considered and rejected (regex-normalizing
  urls; per-kind semantic field whitelist; fixing only in `reconcile.mjs`'s blocker
  construction instead of centrally). 2 concerns raised and resolved: missing
  `ci-retrigger` coverage (added a unit test) and no assertion that persisted state
  still carries the freshest display `url` (added to the cycle-2/3 integration test).
- Code review (`claude-sonnet-4.6`): round 1 clean, 0 concerns. No further rounds needed.

## Scope discipline

Infrastructure-only: no sprite/asset/Azure mutation, no manual mutation of PR #1809's
labels/workflows, no Wave B content touched. `reconcile.mjs` itself is untouched — only
`state.mjs`'s fingerprint helper and the two test files changed.
