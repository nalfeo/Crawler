# Handoff: batfolk-boss PR recovery

**Date:** 2026-07-17
**Persona:** Graphics Designer
**Apples:** estimated 1🍎 / actual 1🍎

## Systems touched

sprite-pipeline, floor2-enemies

## Summary

Recovered PR #1225's batfolk-boss brief review blockers by aligning the source
brief with issue #1218's actual requirements and correcting the session record.

## Files touched

- `briefs/enemies/batfolk-boss.yaml`
- `docs/knowledge/handoffs/2026-07-16-batfolk-boss-sprite-pipeline.md`
- `docs/knowledge/handoffs/2026-07-17-batfolk-boss-pr-recovery.md`

## What changed

- Added `sizeVariant: large` so `loadBrief()` no longer falls back to the
  default 64×64 enemy geometry for future batfolk-boss pipeline runs.
- Changed the enemy facing override from `right` to `front` so the generated
  prompt no longer conflicts with the brief's front-facing prose.
- Clarified the `maxVariants` comment to describe it as a cost cap rather than
  a required approval count.
- Updated the prior handoff to state that the checked-in sprite is still the
  existing 64×64 approved asset and that this PR only repairs the source brief.

## Verification run

- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅
- `parallel_validation` ✅

## Unresolved issues

- The currently checked-in approved runtime sprite remains `batfolk-boss-var-3`
  at 64×64. A follow-up regeneration/approval pass is still needed if issue
  #1218 is meant to land as a true 128×128 large asset rather than just a
  corrected source brief.

## Recommended next steps

1. Regenerate `batfolk-boss` from the corrected brief and approve a true large
   artifact if the issue is intended to close as fully complete.
