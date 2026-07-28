# Handoff: Decouple INDEX.md from PR merge path

## Summary

Implemented the fix for issue #1856 (part of epic #1850): stop
`docs/knowledge/handoffs/INDEX.md` from serializing the merge queue by preventing
agents from committing it to PR branches and by making the merge-train auto-resolve
it when it does appear.

## Problem solved

Nearly every PR was regenerating the single shared `INDEX.md`, causing merge
conflicts for every other concurrent PR and effectively serializing the queue.
The `docs-update.yml` workflow already rebuilds INDEX.md post-merge on main, so the
gap was a missing prevention + conflict-resolution layer.

## Changes

### `pr-preflight.mjs`
- Added `checkIndexMdNotModified(files)` and `INDEX_MD_RE` constant
- Denies `create_pull_request` when `docs/knowledge/handoffs/INDEX.md` is in the
  branch diff
- Remediation message uses `git restore --source=origin/main --staged --worktree`
  (NOT `git rm --cached` which would stage a deletion of a tracked file)
- Exception note for `automation/docs-update` branch included in message

### `reconcile-lib.mjs`
- Modified `buildCandidate()` to auto-resolve INDEX.md-only conflicts:
  - Parses `git ls-files --unmerged` output (deduped by path using Set)
  - If INDEX.md is the ONLY conflict: `git checkout HEAD -- INDEX.md && git add --all`
    then continues (no MergeTrainConflictError thrown)
  - `git add --all` is used (not `git add INDEX.md`) to ensure newly-added files from
    the PR that squash-merge leaves untracked are staged for the candidate commit
  - Mixed conflicts (INDEX.md + other files) still abort and throw MergeTrainConflictError

### Tests
- `pr-preflight.test.mjs`: 4 new tests (deny with actionable message, Windows path,
  alongside other files, clean diffs allowed)
- `reconcile.test.mjs`: 2 new tests (INDEX.md-only auto-resolves; INDEX.md + other
  file still throws conflict error)
- All 82 targeted guard tests pass; 9 pre-existing unrelated failures unchanged

## Files touched

- `.github/extensions/copilot-guards/guards/pr-preflight.mjs`
- `.github/extensions/copilot-guards/tests/pr-preflight.test.mjs`
- `.github/scripts/merge-train/reconcile-lib.mjs`
- `.github/scripts/merge-train/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-28-decouple-index-md.review-ledger.json`

## Systems touched

ci-harness, merge-train

## Verification

Ran `node --test .github/extensions/copilot-guards/tests/pr-preflight.test.mjs .github/scripts/merge-train/reconcile.test.mjs` — 82 pass, 0 fail.

## Review

3🍎 review harness completed. Review ledger:
`docs/knowledge/review-ledgers/2026-07-28-decouple-index-md.review-ledger.json`

Plan review (gpt-5.4): approved_with_changes, 3 concerns, all resolved.
- Blocking concern: `git rm --cached` stages deletion; fixed to `git restore --source=origin/main`
- Non-blocking: docs-update.yml trigger scope acknowledged
- Suggestion: added automation/docs-update exception note

Code review round 1 (claude-opus-4.8): found 2 concerns:
1. Critical: `git add INDEX.md` drops newly-added PR files that squash-merge leaves
   untracked; fixed by using `git add --all` instead
2. Test stub didn't model the failure; updated assertion to check `add --all`

Code review round 2 (claude-opus-4.8): clean.

## Acceptance criteria status

| Criterion | Status |
|-----------|--------|
| Two PRs with handoffs don't conflict on INDEX.md | ✅ Guard prevents it; merge-train auto-resolves if it slips through |
| INDEX.md stays correct on main | ✅ docs-update.yml already handles this (unchanged) |
| No INDEX regeneration on feature PR merge paths | ✅ Guard blocks feature branches from carrying INDEX.md; docs-update remains the dedicated automation PR path |
| PRs' mergeStateStatus stays clean | ⚠️ Not yet directly observed with two concurrent stacked handoff PRs in this session |

## Unresolved issues

Live observation for the two-concurrent-PR `mergeStateStatus` criterion has not been
captured in this session; this handoff now records that criterion as pending direct
artifact evidence instead of inferred complete.
