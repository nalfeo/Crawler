# Handoff: gnome-wheelman asset check-in

**Date:** 2026-08-01  
**Session:** asset-pr for issue #2639  
**Apple estimate:** 1🍎  

## Systems touched

sprite-pipeline, sprite-workflow

## Summary

Checked in 1 approved asset from branch `assets/checkin-20260801-173438-30e183` (issue #2639):

- `public/assets/generated/gnome-wheelman-var-1.png` (103 KB, 256×284 canvas)
- `public/assets/generated/entries/gnome-wheelman-var-1.json`

Asset metadata:
- **briefId:** `gnome-wheelman`
- **type:** enemy
- **judgeScore:** 4/5 (confidence 0.92)
- **sensorScore:** 7/7 (all sensor checks passed)
- **facingDirection:** right
- **anchor:** (135, 152) derived

## Wiring needed (follow-up)

`src/shared/generated-assets.ts` line 617 currently maps `gnome-wheelman` to the `gnome-tinker` placeholder:

```ts
'gnome-wheelman': 'gnome-tinker',
```

After this PR merges, open a separate non-art PR to update this to:

```ts
'gnome-wheelman': 'gnome-wheelman',
```

The enemy is already defined in `src/shared/data/enemies.floor2.json`. The wiring PR must run the full CI gates (not the art-only fast lane).

## PR

PR #2640 — art-only fast lane (`art_only=true`, `gameplay_safe=true`).
Closes #2639.
