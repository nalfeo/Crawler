# Handoff: llama-curb-stomper asset check-in

**Date:** 2026-08-01  
**Session:** copilot/assetscheckin-20260801-181522-7be968  
**Apple estimate:** 🍎  
**PR:** #2651 (art-only, closes #2650)

## Systems touched

sprites

## What was done

Checked in approved `llama-curb-stomper-var-0.png` from branch
`assets/checkin-20260801-181522-7be968` into PR #2651.

Files added (art-only, CI fast lane):

- `public/assets/generated/llama-curb-stomper-var-0.png`
- `public/assets/generated/entries/llama-curb-stomper-var-0.json`

CI all green. PR is in draft state — needs `gh pr ready 2651` then
`gh pr merge 2651 --auto --squash` to complete the merge.

## Wiring follow-up required

`src/shared/generated-assets.ts` `GENERATED_BRIEF_BY_APPEARANCE_KEY` currently
maps `'llama-curb-stomper': 'llama-spitter'` (placeholder). After this PR merges,
open a separate non-art wiring PR to change it to
`'llama-curb-stomper': 'llama-curb-stomper'`.
