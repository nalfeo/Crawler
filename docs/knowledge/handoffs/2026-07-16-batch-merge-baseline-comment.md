# Handoff: Fix batch-merge PRs missing baseline win-rate comment

**Date:** 2026-07-16  
**Session slug:** batch-merge-baseline-comment  
**Apple estimate:** 1🍎  
**PR:** Closes #1201

## Systems touched

ci-policy

## Summary

Fixed a structural gap where PRs merged in a batch by the merge train never received the 📊 Baseline win-rate comment, only the last PR in the batch did.

## Root cause

When the merge train lands multiple PRs in quick succession (a "batch"), each commit triggers its own CI run which triggers a `deploy.yml` run. The `deploy` job has `concurrency: group: pages, cancel-in-progress: true`, so earlier deploy jobs get **cancelled** as newer ones queue up. Because `baseline-sweep` has `needs: deploy`, when deploy is cancelled the baseline-sweep is also cancelled — GitHub Actions propagates the cancellation.

Only the **last** PR in a batch gets the baseline comment.

The deploy job's "Label and comment on released PRs" step is NOT affected (it runs in the surviving deploy run and labels **all** unlabeled merged PRs). This is why all PRs in a batch get the 🚀 Released comment but only the last one gets the 📊 comment.

**Confirmed examples:**

- 07:07 batch (PR #1174, #1177): PR #1177 (second) got no baseline comment.
- 07:36 batch (PR #1172, #1176, #1180, #1184, #1185, #1186): Only PR #1186 (last) got the comment.

**Note on PR #1200** (the triggering PR for issue #1201): it was filed 7 minutes after run #740's baseline-sweep started. The sweep takes ~1 hour — the comment was just pending. The issue's described symptom ("no longer get") is the real batch-merge gap.

## Fix

Changed `deploy.yml` so baseline comment targeting is scoped to the exact PR set selected by the matching deploy run:

1. Added a `deploy` job step (`Select released PR targets`) that computes merged+unreleased `PR_NUMBERS` once.
2. Exported that list as a deploy job output: `outputs.released_pr_numbers`.
3. Updated `baseline-sweep` comment step to target only `SPECIFIC_PR ∪ needs.deploy.outputs.released_pr_numbers` (deduped), instead of querying global `"released"` labels.
4. Kept idempotency guard (`"📊 Baseline win-rate"` comment already present) so reruns/overlap stay safe.
5. Added a warning path when PR-target selection fails, rather than silently suppressing all errors.

This removes cross-run misassociation risk during overlapping releases and avoids missing current-batch PRs due list caps/order.

## Files changed

- `.github/workflows/deploy.yml` — deploy output wiring + scoped baseline comment targets
- `tests/unit/deploy-baseline-comment-targeting.test.ts` — regression assertions for scoped targeting

## Backward compatibility

- Existing PRs that already have the baseline comment: skipped by idempotency check ✓
- Single-PR deployments (no batch): behavior identical to before ✓
- Direct pushes to main (no PR): falls through gracefully with notice log ✓
- Historical PRs without the comment: would receive the comment on the next deploy sweep (using the current code's win-rate), which is slightly inaccurate but far preferable to permanent absence

## Testing

- `npm run verify:fast` passes (87 test files, 1218 tests) ✓
- `npx vitest run tests/unit/deploy-workflow-gating.test.ts tests/unit/deploy-baseline-comment-targeting.test.ts` ✓
- The fix is in a GitHub Actions workflow step; full validation requires observing the next batch merge on CI
