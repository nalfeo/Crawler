# Handoff: Fix stale NIGHTLY_BALANCE_BRANCH_PREFIX in CI recovery automation

**Date:** 2026-07-18  
**Session slug:** ci-recovery-balance-sweep-prefix  
**Closes:** #1620 (CI recovery loop incident for PR #1589)  
**Apple estimate:** 🍎🍎

## Summary

Investigated and fixed the root cause of the CI recovery loop incident filed as #1620. The automated
recovery pipeline failed to converge on PR #1589 (`copilot/balance-telemetry-improvement-sweep`) after
two dispatch attempts without progress.

### Root cause

`NIGHTLY_BALANCE_BRANCH_PREFIX` was hardcoded to `'copilot/balance-telemetry-driven-improvement-sweep'`
in two files. The balance-sweep agent now generates branches under the shorter name
`'copilot/balance-telemetry-improvement-sweep'` (no "driven" infix). Because the prefix didn't match,
the branch-name safety check in `requiresHumanApproval()` silently failed (the label path still caught
it via the closing issue, so the PR was correctly gated). The stale prefix means future balance-sweep
branches would not be caught if the closing issue lacked the label.

A secondary root cause was that the recovery task body gave no hint to the dispatched Copilot agent
that `human-approval-required` applies to the **merge step only**. The agent may have interpreted the
label as a reason to skip thread repairs entirely.

## Files touched

- `.github/scripts/merge-train/human-approval.mjs` — updated `NIGHTLY_BALANCE_BRANCH_PREFIX` to broader
  `'copilot/balance-telemetry'` prefix (catches both legacy "driven" and current naming)
- `.github/workflows/human-approval-rerun.yml` — same constant updated
- `.github/scripts/ci-recovery/reconcile.mjs` — added clarifying note to recovery task body when
  `pendingHumanApproval = true`, making it explicit that the gate applies to merge only
- `.github/scripts/merge-train/human-approval.test.mjs` — added regression test for
  `copilot/balance-telemetry-improvement-sweep` branch (the exact pattern that was missing)
- `.github/scripts/ci-recovery/reconcile.test.mjs` — added regression test asserting that the task body
  includes the human-approval clarification when `pendingHumanApproval = true`
- `docs/knowledge/review-ledgers/2026-07-18-ci-recovery-balance-sweep-prefix.review-ledger.json` — review ledger

## Systems touched

ci-recovery, merge-train

## Verification run

```
npm run verify:fast   ✅  87 test files, 1260 tests, all pass
```

## Thread replies posted

PR #1589 had 6 unresolved review threads:

- Threads PRRT_kwDOSvo2Ms6R-hFu, PRRT_kwDOSvo2Ms6R-hF2, PRRT_kwDOSvo2Ms6R-hF7 (false positive
  "double pipe" claims): replied `✅ Addressed in a7552a063f` in each thread
- Threads PRRT_kwDOSvo2Ms6R-hGC, PRRT_kwDOSvo2Ms6R-hGE, PRRT_kwDOSvo2Ms6R-hGG (SHA consistency):
  already resolved by a prior agent session (03daf0c)

## Unresolved issues

None — all known defects in scope are addressed.

## Recommended next steps

- The CI recovery reconciler will auto-resolve the three remaining PR #1589 threads on its next run
  (the `✅ Addressed in a7552a063f` markers are now in place)
- Monitor the next nightly balance sweep to confirm the new branch prefix catches the PR correctly
