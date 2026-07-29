# Handoff — Deflake cancel-judge e2e

**Date:** 2026-06-28 · **Persona:** Producer

## Apples

Estimated 🍎🍎 (Small). Actual 🍎🍎. Verdict 🎯 Exact — sticky-status fix + test wait + cold-start timeout bump, two files.

## Summary

De-flaked `tests/e2e/sprite-workflow-sensors.test.ts > … > cancels a running Judge step and
restores the prior stage for retry` (~1/4 red), which reddened the required `ci` aggregate
(E2E Visual Regression) after merges. Root cause: the cancel handler wrote a **transient**
`Canceled Judge` status after re-rendering, and a slow boot task (`recompute`/`hydrate`, which
fetch `/assets/**` and are NOT aborted by the `/api/**` mock) could finish later, re-run
`renderWorkflowSelection()`, and clobber it to `Next: Judge` before the single synchronous read.

## Fix

- Added `lastCanceledStep` map (mirrors `lastFailedStep`); `renderWorkflowSelection` re-surfaces
  `Canceled <step>…` on every render so a late re-render can't overwrite it. Cleared on step
  retry + success (`applyRunToQueue`).
- Test polls for `Canceled Judge` via `waitForFunction`; raised cold-Vite `goto`/`reload`
  timeouts to 60s (separate cold-start flake on the first test) to match the 60s body wait.

## Files touched

- `src/devtools-main.ts` — sticky cancel note + clears
- `tests/e2e/sprite-workflow-sensors.test.ts` — deterministic wait + timeouts

## Verification

- `npm run verify:fast` ✓
- cancel test 11/11 green; sensors file 3× cold ✓ (7/7 each); full e2e 23/23 across 5 files ✓
- Before: reproduced flake (status `Next: Judge`); After: green across consecutive runs.

## Unresolved / next steps

None. Suite hermetic (no Azure/LLM). Watch for other suites sharing the cold-Vite first-hit cost.
