# Handoff: grave-shovel weapon brief (issue #1439 duplicate path)

**Date:** 2026-07-18  
**Session type:** Art pipeline (brief commit, no runtime code change)  
**Branch:** `copilot/asset-request-grave-shovel-again`  
**Apple estimate:** 🍎🍎

## Summary

Added the production brief `briefs/weapons/grave-shovel.yaml` for the Floor 2
equipment weapon runtime key `equipment/weapon/grave-shovel`.

The brief keeps the canonical weapon defaults from
`data/sprite-types/weapon.json` (4×4 sheet, vertical weapon orientation,
center-bottom grip anchor, VLM judge enabled), and adds focused description +
variation seeds for a silhouette-readable grave shovel polearm.

## Files Touched

- `briefs/weapons/grave-shovel.yaml` — new weapon sprite brief
- `docs/knowledge/handoffs/2026-07-18-grave-shovel-brief-again.md` — this handoff

## Verification Run

- `npm run verify:fast` — ✅
- `npm run verify:pr-prereqs` — ✅

## Notes / Unresolved

- The issue thread requested a pre-code plan comment on #1439. I attempted to
  post it from this session, but GitHub API comment writes are blocked in this
  environment (HTTP 403 via DNS monitoring proxy).
- #1439 is marked duplicate of #1321; the canonical generation/checkin stages
  still run through the normal asset-request pipeline.

## Systems Touched

sprite-pipeline, sprite-workflow
