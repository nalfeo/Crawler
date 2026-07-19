# Handoff: plague-censer sprite brief + placeholder

**Date:** 2026-07-19  
**Session:** copilot/add-plague-censer-icon-again  
**Apple estimate:** 1 🍎 (art lane, review-ledger-exempt)  
**Issue:** nalfeo/Crawler#1355  
**Aggregate:** nalfeo/Crawler#1303

## Summary

Authored the `plague-censer` magic-focus weapon brief and ported the placeholder
manifest entry + PNG from the `nalfeo-floor-2-equipment-placeholders` branch so
the runtime key `equipment/weapon/plague-censer` resolves in game without
crashing.

## Systems touched

- `briefs/weapons/plague-censer.yaml` — new weapon brief (faceted corroded-brass censer, verdigris + sickly green-yellow vapor, vertical orientation, Floor 2 magic-focus)
- `public/assets/generated/manifest.json` — added `equipment/weapon/plague-censer` placeholder entry
- `public/assets/generated/equipment/weapon/plague-censer-placeholder.png` — 16×16 placeholder PNG (sourced from `nalfeo-floor-2-equipment-placeholders`)

## Pipeline status

| Stage                      | Status                                              |
| -------------------------- | --------------------------------------------------- |
| Brief authored             | ✅ briefs/weapons/plague-censer.yaml                |
| Placeholder manifest entry | ✅ sourceRun=floor2-equipment-placeholder/v1        |
| Azure generation           | ❌ BLOCKED — initial run cancelled (id=29625233105) |
| Judge/approve/checkin      | ⏳ Pending real generation                          |
| Art-only asset PR          | ⏳ Pending                                          |
| Wiring (code PR)           | ⏳ Pending real art                                 |

## Why generation is blocked

The `asset-request.yml` run for issue #1355 (run id=29625233105) was **cancelled
within 2 seconds** on 2026-07-18T01:27:44Z — likely cancelled by the wave
of 40+ concurrent issue-triggered runs all queuing under the same
`${{ github.workflow }}-worker` concurrency group. Subsequent workflow_dispatch
runs on 2026-07-18T03:01 regenerated `void-rapier` and `dueling-saber` from
the same magic-focus wave but **missed plague-censer**.

## Next steps for next session

1. **Trigger generation:** Maintainer re-opens issue #1355 (or `gh workflow run asset-request.yml`) to re-trigger the pipeline.
2. **Judge variants:** Apply `sprite-judge` skill to the generated 4×4 sheet.
3. **Approve winner:** `npm run sprites:approve -- <runDir> --variant <N>`
4. **Check in:** `npm run sprites:checkin` → creates `asset-checkin` issue
5. **Asset PR:** `npm run sprites:asset-pr` → art-only PR (review-ledger-exempt)
6. **Wire:** `npm run sprites:generate-wiring -- --since main` → code PR with full gates + ledger

## Style brief summary

> Faceted corroded-brass censer on a short chain grip. Sickly green-yellow vapor
> seeping from the perforations. 3 dark corrosion-stops + verdigris accent.
> Silhouette: lantern head → chain links → leather-wrapped grip. Vertical
> orientation (grip bottom). No magic aura, no sparkle — just quiet plague seep.
