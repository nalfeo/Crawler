# Handoff: Fix repair-label stuck-forever bugs in pr-ready-reviewer-guard

**Date:** 2026-07-18  
**Branch:** nalfeo-repair-empty-copilot-drafts  
**PR:** #1572  
**Apple estimate:** 1🍎

## Summary

Two targeted bug fixes in `.github/scripts/pr-ready-reviewer-guard.mjs` addressing review
feedback on the empty-Copilot-draft repair path. Both bugs could cause a PR to permanently
retain the `copilot-empty-draft-repaired` label on an open/reopened PR, silently blocking
all future repair scans.

## Systems touched

ci-recovery

## Files touched

- `.github/scripts/pr-ready-reviewer-guard.mjs` — production fixes (3 changes)
- `.github/scripts/pr-ready-reviewer-guard.test.mjs` — 3 new regression tests

## What changed

### Bug 1: Close failure did not remove repair label (thread 3609136742 at line 420)

When `updatePullState('closed')` fails and the ambiguity check confirms the PR is still
open (definite close failure), the code was throwing without first removing the repair
label that was already applied. The PR would remain open with `copilot-empty-draft-repaired`
permanently, making every future scan skip it as "already repaired."

**Fix:** In the inner catch block of the close attempt, remove the label (best-effort,
suppress all errors since we are already in a definite failure path) before throwing.

### Bug 2: `removePrLabel` silently suppressed all errors (thread 3609136756 at line 651)

The `removePrLabel` API method used `.catch(() => {})` to swallow every error. The
surrounding rollback paths (issue-mutation rollback, `rollbackClose`) also discarded
cleanup failures. A non-404 API error (rate-limit, 5xx, etc.) would leave the label on
an open PR that was reopened after a rollback, blocking future scans forever.

**Fix (in `createApi`):** `removePrLabel` now only suppresses 404 (label already gone)
and propagates all other errors.

**Fix (in `rollbackClose`):** Removed the per-call try/catch around `removePrLabel`; the
function now propagates non-404 errors to the caller. Post-close drift paths surface as
repair failures rather than silent skips when label cleanup fails.

**Fix (in issue-mutation rollback):** Label removal errors are now caught and pushed into
`rollbackErrors`, appearing in the `AggregateError` message chain.

## Verification

```
node --test .github/scripts/pr-ready-reviewer-guard.test.mjs
# 50 tests, 0 failures (was 47 before this fix)

node --test .github/scripts/ci-recovery/issue-intake.test.mjs
# 11 tests, 0 failures

npm run verify:fast
# 1 pre-existing shallow-clone failure in epic-status.test.ts (unrelated)
```

## Unresolved issues

None. Both threads are fully addressed with regression coverage.

## Recommended next steps

After merge, the CI run on this branch should be clean. The two new tests cover both
failure scenarios deterministically.
