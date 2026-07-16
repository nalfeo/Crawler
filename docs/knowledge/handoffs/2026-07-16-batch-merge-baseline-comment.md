# Handoff: Fix batch-merge PRs missing baseline win-rate comment

**Date:** 2026-07-16  
**Session slug:** batch-merge-baseline-comment  
**Apple estimate:** 1🍎  
**PR:** Closes #1201

## Systems touched

deploy, merge-train

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

Changed the "Comment baseline win-rate on released PR" step in `.github/workflows/deploy.yml` (`baseline-sweep` job) to:

1. Keep the existing path: resolve the specific PR for the swept SHA via `resolve-landed-pr.mjs` (non-fatal on failure; continues to label-based fallback)
2. **New:** also query `gh pr list --label "released" --limit 50` for all recently released PRs
3. Deduplicate and iterate over the union
4. **Idempotency check:** skip any PR whose comments already contain `"📊 Baseline win-rate"` (guards against double-posting on re-runs and overlapping sweeps)
5. Post on all remaining PRs

The surviving deploy run's baseline-sweep now posts the comment on ALL batch PRs (they all have the "released" label from the surviving deploy's "Label and comment on released PRs" step), not just the one whose commit was swept.

## Files changed

- `.github/workflows/deploy.yml` — "Comment baseline win-rate on released PR" step only

## Backward compatibility

- Existing PRs that already have the baseline comment: skipped by idempotency check ✓
- Single-PR deployments (no batch): behavior identical to before ✓
- Direct pushes to main (no PR): falls through gracefully with notice log ✓
- Historical PRs without the comment: would receive the comment on the next deploy sweep (using the current code's win-rate), which is slightly inaccurate but far preferable to permanent absence

## Testing

- `npm run verify:fast` passes (87 test files, 1218 tests) ✓
- The fix is in a GitHub Actions workflow step; full validation requires observing the next batch merge on CI
