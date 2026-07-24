# Handoff: CI knobs audit — promote dispatch caps to runtime variables

## Date

2026-07-22

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Addresses issue #1779: all operationally-meaningful CI dispatch caps are now
runtime-tweakable via repo Actions variables, with in-code defaults as safe
fallbacks. The 2026-07-22 incident (raising `CI_RECOVERY_MAX_DISPATCH_PER_RUN`
from 1→5 was silently inert because the hardcoded `GLOBAL_TRAIN_DISPATCH_CAP`
clamped the budget) is now resolved: both global caps are env-driven and
take effect immediately on the next router invocation.

## What changed

### `.github/scripts/ci-recovery/router.mjs`
- `GLOBAL_TRAIN_DISPATCH_CAP` / `GLOBAL_IDLE_TRAIN_DISPATCH_CAP` are now the
  **default fallback values** for the new `CI_GLOBAL_TRAIN_DISPATCH_CAP` /
  `CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP` env vars. Both constants remain exported
  for backward compat (existing tests assert `=== 5`).
- Added `export function resolveGlobalDispatchCaps(env)` — reads env overrides
  with fallback to the module constants.
- `computeDispatchBudget` now accepts optional `trainCap`/`idleCap` params
  (default to the module constants), keeping all existing tests working.
- `runFromEnv` now calls `resolveGlobalDispatchCaps(env)` and passes caps
  through to `computeDispatchBudget`.
- Fixed the backpressure log line: now emits `budget=${dispatchBudget}` (the
  effective remaining capacity) alongside `cap=` so operators see the actual
  headroom rather than just the ceiling.

### `.github/scripts/merge-train/reconcile.mjs`
- Imports `resolveGlobalDispatchCaps` instead of the hardcoded constant.
- `buildGatedDispatchRecovery` now uses the runtime-resolved `trainCap`.

### Workflows
- `ci-recovery-router.yml`: added `CI_GLOBAL_TRAIN_DISPATCH_CAP` and
  `CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP` env vars wired from repo variables.
- `merge-train.yml`: added `CI_GLOBAL_TRAIN_DISPATCH_CAP`.

### Docs
- New `docs/agent-os/policies/ci-config-knobs.md` — canonical reference for
  every runtime-tweakable knob, its default, valid range, effect, and
  interactions/clamps. Notes `MERGE_TRAIN_MODE` as vestigial (to delete).
- `docs/agent-os/policies/ci-policy.md`: added banner link to knobs doc.
- `AGENTS.md` Key Files table: added explicit row for the knobs doc.

### Tests
- `router.test.mjs`: added import of `resolveGlobalDispatchCaps` and new tests
  for the override API and env-var parsing.
- `tests/unit/ci-knobs-guard.test.ts` (new): deterministic guard that scans CI
  scripts for file-scope numeric constants and fails if any appear that are not
  registered as either operationally-tweakable or structural.

## Acceptance criteria met

- [x] `CI_GLOBAL_TRAIN_DISPATCH_CAP` and `CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP`
  are repo variables that take effect immediately (no code change + PR needed).
- [x] Clamp chain documented in `ci-config-knobs.md`.
- [x] Effective `budget=` now shown in backpressure log (not just `cap=`).
- [x] `MERGE_TRAIN_MODE` vestigial status documented; deletion instruction in knobs doc.
- [x] Deterministic guard (`ci-knobs-guard.test.ts`) fails on unregistered
  numeric constants.
- [x] Single canonical doc referenced from `ci-policy.md` and `AGENTS.md`.

## Operator action required

Delete the vestigial `MERGE_TRAIN_MODE` repo variable:
```
gh variable delete MERGE_TRAIN_MODE --repo nalfeo/Crawler
```
No code reads it; its presence is misleading.

## Unresolved / follow-up

- Load-aware dispatch throttle (#1776) — dynamic cap based on current runner load.
- CI-fix-first-then-FIFO dispatch ordering — companion follow-up issue.
- Narrow TOCTOU race between router and reconcile.mjs dispatch (durable semaphore
  via repo variable) — noted in existing code comments, not addressed here.
