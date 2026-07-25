# Add Terminal Dispatch Table to CI Recovery dispatch-table.mjs

**Date:** 2026-07-25  
**Slug:** ci-recovery-terminal-dispatch-table

## Systems touched

ci-recovery

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Summary

Investigated why the CI recovery automation failed to converge on PR #1923 after 2 attempts.
Found two root causes:
1. The copilot recovery job (89711006523) failed immediately with "Model 'claude-sonnet-4.5' is not available" — a transient model-unavailability failure, not a code defect.
2. PR #1923 had 4 unresolved reviewer threads. Main already contained the correct code for three of them. The fourth identified `buildTerminalDispatchTable`/`selectTerminalAction` as dead code without unit tests.

This session adds `buildTerminalDispatchTable()` and `selectTerminalAction()` to `dispatch-table.mjs` (on main) with full unit tests, addressing the "terminal table is unwired dead code" review thread.

## Root cause analysis

**Why recovery made no progress:**
- Copilot recovery job crashed with transient model-unavailability error on both attempts.
- PR #1923 had unresolved review threads and a failing CI test, so it could not merge regardless.

**Review thread analysis vs. main branch:**
1. **Thread 1** (R05 doesn't protect owner-blind exits): Main already has pre-exit stale release guards at ~lines 1168 and 1765 of `reconcile.mjs`. ✅ Already on main.
2. **Thread 2** (terminal table unwired): PR added `buildTerminalDispatchTable`/`selectTerminalAction` but did not import/use them in `reconcile.mjs`. Main had no such functions. This session adds them with tests. ✅ Fixed here.
3. **Thread 3** (R09/R10 missing from invariant): Main already includes `WAIT_CONFLICT_REBASE_PENDING` and `WAIT_CONFLICT_REBASE_BACKOFF` in `EARLY_OWNER_BLIND_SKIP_ACTIONS`. ✅ Already on main.
4. **Thread 4** (missing conflict-episode test): Main already has the 2-pass conflict-episode marker test at line 11679 of `reconcile.test.mjs`. ✅ Already on main.

## Files touched

- `.github/scripts/ci-recovery/dispatch-table.mjs` — Added `buildTerminalDispatchTable()` (8 rows: R26, R27, T-ARM, T-EXHAUSTED, R34, R33, T-COPILOT-PROGRESS, T-DISPATCH) and `selectTerminalAction()` (throws on no-match). Updated scope comment to document both tables.
- `.github/scripts/ci-recovery/dispatch-table.test.mjs` — Added imports for `buildTerminalDispatchTable` and `selectTerminalAction`; added 10 new terminal dispatch table unit tests covering all 8 rows plus throw-on-no-match.

## Verification

- `node --test .github/scripts/ci-recovery/dispatch-table.test.mjs` ✅ (32 tests, 0 failures)
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` ✅ (136 tests, 0 failures)
- `npm run verify:fast` ✅ (1719 tests, 0 failures)

## Recommended next steps

- Watch CI on this PR; if green, arm squash auto-merge
- Reply to the reviewer threads on PR #1923 noting that the issues addressed here (and already on main) resolve their concerns
- Follow-up: wire `selectTerminalAction` into `reconcile.mjs` to replace the inline terminal cascade (explicitly deferred by this change; marked with TODO in the file)

## Unresolved issues

- PR #1923 itself still needs its own CI fixed and threads resolved before it can merge (separate work).
- The `selectTerminalAction` wiring into `reconcile.mjs` is explicitly deferred to a follow-up.
