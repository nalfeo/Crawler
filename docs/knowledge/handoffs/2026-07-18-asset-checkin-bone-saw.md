# Handoff: Asset check-in — bone-saw-var-1

**Date:** 2026-07-18  
**Session:** asset-checkin-bone-saw  
**Apple estimate:** 1🍎 (art-only batch PR)  
**PR:** #1569

## Systems touched

sprite-pipeline

## What was done

Consolidated 1 approved `asset-checkin` issue (#1561) into a game PR (#1569).

### Issue processed

- **#1561** — `assets/checkin-20260718-025909-48cadc`, 1 asset: `generated/bone-saw-var-1.png` (bone-saw weapon sprite, variant 1, sensorScore 8/8, judgeScore 4)

### Files changed (art-only)

| File                                         | Change                               |
| -------------------------------------------- | ------------------------------------ |
| `public/assets/generated/bone-saw-var-1.png` | New PNG, 4784 bytes                  |
| `public/assets/generated/manifest.json`      | +1 entry: `bone-saw-var-1`           |
| `src/shared/data/sprite-catalog.json`        | +1 entry: `generated:bone-saw-var-1` |

## Key decisions

1. **Manual fallback used:** `npm run sprites:asset-pr` refused to run in the agent environment because `process.env.CI` is set (Constitutional §3: asset-PR consolidation is local-only). Used the manual fallback from the playbook.

2. **Surgical manifest merge:** The check-in branch (`assets/checkin-20260718-025909-48cadc`) was cut from `nalfeo-floor-2-equipment-placeholders`, so its manifest included 71 new entries (1 approved bone-saw + 70 floor-2 equipment placeholders). I only added the 1 approved `bone-saw-var-1` entry to main's manifest, not the 70 placeholder entries which belong to the floor-2 equipment PR (#1302).

3. **`type: null`:** The manifest entry has `type: null` (pipeline output). The brief specifies `type: weapon`. This is a known pattern (163/299 entries share it); not fixed here since it's a pipeline concern.

## Wiring status

`npm run sprites:placeholder-audit` shows `new-real-assets=0` — no existing registered placeholder matches `bone-saw` (the floor-2 equipment system hasn't landed on main yet). Wiring will happen when:

- PR #1302 (floor-2 equipment placeholders) lands, OR
- A dedicated wiring PR is opened after the equipment system is registered

## What's left

- PR #1569 needs CI to pass (currently queued — art-only fast lane: typecheck/lint/unit only)
- Auto-merge should be armed once CI starts passing
- Post-merge: run `npm run sprites:placeholder-audit -- --since main` to confirm no new wiring opportunities emerged
