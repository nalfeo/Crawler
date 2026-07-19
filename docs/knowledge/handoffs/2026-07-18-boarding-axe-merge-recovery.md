# Boarding axe PR merge recovery

**Date:** 2026-07-18
**Session:** PR #1522 merge-conflict recovery
**Apple estimate:** 2

## Summary

Merged `origin/main` into the boarding-axe sprite branch after `main` advanced with
additional Floor 2 asset and sprite-workflow changes. The conflict resolution kept the
branch's hand-authored `boarding-axe-var-0` manifest/catalog entries while preserving the
newer upstream Floor 2 brief shape and the newly landed `main` asset/catalog additions.

## Systems touched

sprite-workflow

## Files touched

- `briefs/weapons/boarding-axe.yaml` — resolved the add/add brief conflict in favor of the current Floor 2 brief variant from `main`
- `public/assets/generated/manifest.json` — kept the boarding-axe asset entry and preserved the upstream manifest additions that landed on `main`
- `src/shared/data/sprite-catalog.json` — preserved the boarding-axe metadata + goblin note fix while keeping the new upstream catalog tail entries

## Verification

- `git diff --name-only --diff-filter=U` (confirmed the conflict set before resolution)
- `npm run verify:fast` (to run after finalizing the merge commit in the unshallowed repository)

## Unresolved issues

- None.
