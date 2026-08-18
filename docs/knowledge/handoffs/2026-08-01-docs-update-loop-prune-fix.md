# Handoff: Fix docs-update --force-with-lease stale-info failure

**Date:** 2026-08-01  
**Session slug:** docs-update-loop-prune-fix  
**Apple estimate:** 🍎 (trivial — single CI workflow file change)  
**PR:** #2646

## Summary

Fixed a recurring `--force-with-lease` stale-info rejection in the
`docs-update` workflow that prevented the `automation/docs-update` PR from
being created or updated.

## Root cause

The workflow uses `fetch-depth: 0` on checkout, which fetches all remote refs
including `automation/docs-update` (from the previous docs-update PR). When
that PR is merged and the branch deleted before the `create-pull-request` step
runs, the local tracking ref `refs/remotes/origin/automation/docs-update`
still points to the deleted branch's SHA. The `peter-evans/create-pull-request@v7`
action pushes with `--force-with-lease`, which checks: "is the remote at the
expected SHA from my tracking ref?" The remote no longer has the branch, so
the lease check fails with "stale info".

The 25-second Prettier pre-push hook compounds the problem by opening a race
window between when git connects to the remote (establishing the lease) and
when it actually performs the ref update.

## Fix

Added a `git fetch --prune origin` step immediately before the
`create-pull-request` step in `.github/workflows/docs-update.yml`. This:

- Removes tracking refs for branches deleted on the remote (the primary fix)
- Updates tracking refs for branches that exist but have new commits
- Ensures `--force-with-lease` uses accurate, fresh data

## Files changed

- `.github/workflows/docs-update.yml` — new "Prune stale remote tracking refs" step
- `docs/knowledge/review-ledgers/2026-08-01-docs-update-loop-prune-fix.review-ledger.json` — 1🍎 review ledger

## Related

- Issue #2645 (this incident)
- Issue #2641 (earlier incident, similar cause)
- PR #2642 used a retry approach for the same root cause — this fix addresses the root cause directly

## Systems touched

ci, docs
