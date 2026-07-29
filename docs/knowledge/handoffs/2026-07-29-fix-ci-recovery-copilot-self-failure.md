# Fix CI Recovery Copilot Self-Failure Loop

**Date:** 2026-07-29  
**Session slug:** fix-ci-recovery-copilot-self-failure  
**Apple estimate:** 2🍎  
**Closes:** #2326 (loop incident for PR #2010)

## Systems touched

ci-recovery

## Summary

Closes the final gap that caused CI recovery loop incident #2326 (PR #2010,
"Implement Overseer Fizzwick's CLOCKWORK KILL-SAW ability").

When all review threads are resolved (e.g. via the near-typo SHA promotion
from PR #2116), `ci-failure copilot` was still in the `normalized` blockers
list. The terminal dispatch table evaluated `blockersPresent: normalized.length > 0`
as `true` and dispatched Copilot again — which immediately failed at
`session.create` (model `claude-sonnet-4.5` deprecated) — recreating the same
`ci-failure copilot` blocker and cycling until the stale-retry ceiling filed
a loop incident.

**Fix:** compute `effectiveBlockers` (same `ci-failure copilot` exclusion as
`blockerFingerprint()` in state.mjs) and use `effectiveBlockers.length > 0`
for `blockersPresent` in the terminal context. This routes the PR to
`ARM_AUTO_MERGE` (all checks passing) or `WAIT_ADMISSION` (checks absent)
instead of re-dispatching Copilot.

## Root causes of PR #2010 incident (full picture)

1. **`claude-sonnet-4.5` deprecated** — every Copilot session.create failed.
   Fixed upstream in PR #2210 (model deprecation docs, loop-incident-close fix).

2. **SHA typo in ADR review thread** — marker SHA `e6380eb...20afef77` vs
   actual head `...19afef77` (2 adjacent hex digits `19`→`20`). The
   pre-#2116 near-typo logic only handled 1 digit. Fixed upstream in PR #2116
   (near-typo extended to 2 contiguous digits).

3. **`ci-failure copilot` counted in `blockersPresent`** (this session's fix) —
   even after all real blockers are resolved, `ci-failure copilot` remained in
   `normalized` and set `blockersPresent=true`, causing unnecessary re-dispatch.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs` — added `effectiveBlockers` filter,
  log line `skipping-copilot-self-failure`, changed `blockersPresent` computation.
- `.github/scripts/ci-recovery/reconcile.test.mjs` — added regression test for
  ci-failure-copilot-only → ARM_AUTO_MERGE; updated tests 141 and 142 (PR #1809
  cycle 2/3 and 3/3) to expect WAIT_ADMISSION instead of DISPATCH_COPILOT.

## Verification

- 159 reconcile tests pass (`node --test .github/scripts/ci-recovery/reconcile.test.mjs`)
- 55 state tests pass (`node --test .github/scripts/ci-recovery/state.test.mjs`)

## Unresolved issues

None.

## Recommended next steps

- Monitor that PR #2010's ADR review thread auto-resolves via the near-typo
  promotion (already in main via #2116).
- The `claude-sonnet-4.5` deprecation should be handled at the org-settings
  level (already tracked separately).
