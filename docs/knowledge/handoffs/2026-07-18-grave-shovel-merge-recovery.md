# Handoff: grave-shovel PR merge recovery

**Date:** 2026-07-18  
**Session:** PR #1532 merge-conflict recovery  
**Apple estimate:** 1

## Summary

Merged `origin/main` into `copilot/asset-request-grave-shovel-again` after the PR
fell behind. The only content conflict was the add/add `grave-shovel` brief; the
resolved file keeps the branch's runtime-key/test clarification notes while
preserving the newer upstream anchor wording.

## Systems touched

sprite-pipeline, sprite-workflow

## Files touched

- `briefs/weapons/grave-shovel.yaml` — resolved the add/add merge conflict by keeping both valid clarifications

## Verification

- `npm run verify:fast` — ✅
- `npm run verify:pr-prereqs` — ✅

## Unresolved issues

None.
