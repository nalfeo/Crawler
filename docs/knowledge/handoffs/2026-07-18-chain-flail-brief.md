# Handoff: chain-flail weapon brief (Floor 2 bludgeon wave)

**Date:** 2026-07-18  
**Agent:** Asset Forge (Graphics Designer persona)  
**Apple estimate:** 1🍎  
**PR:** Related to #1308 (kept open for workflow trigger)

## Summary

Authored `briefs/weapons/chain-flail.yaml` for the Floor 2 bludgeon production wave (`floor2-equipment-weapon-bludgeon`). This is a pure art/brief task — no engine code, no registry wiring, no review harness or ledger required.

## Systems touched

sprite-workflow

## Design decisions

- **Orientation: vertical** (default, inherited from `data/sprite-types/weapon.json`). The flail is composed vertically — haft at bottom, chain rising, spiked ball at top. No sensor override needed.
- **No anchor override** — default `(32, 56)` is correct for a vertically-oriented weapon with the handle at the bottom.
- **Floor 2 palette** — cool near-black iron tones, dark muted wood for haft, reflecting the darker/more threatening aesthetic of Floor 2 enemies and equipment.
- **Chain differentiator** — brief explicitly calls out 2–3 visible chain links that must read as _chain not rope_, and flags that the chain gap between haft and ball is the distinguishing feature vs. a morning star (rigid pole).
- **`minVariations: 6`** — standard for weapon briefs in this wave.
- **2 seed variations:** barbed pear-shaped weight, double-link chain — guarantee silhouette variety without drifting from the core design intent.

## Pipeline state

| Step                                               | Status                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| Brief authored                                     | ✅ `briefs/weapons/chain-flail.yaml`                                  |
| `verify:fast`                                      | ✅ 87 files, 1260 tests passed                                        |
| Committed + PR opened                              | ✅ PR #1316 (issue #1308 remains open for workflow trigger)           |
| Generation (Azure sidecar)                         | ⏳ trigger via issue event or `workflow_dispatch` on #1308            |
| Judge / approve / check-in / asset-PR              | ⏳ next wave step after generation                                    |
| Wire to runtime key `equipment/weapon/chain-flail` | ⏳ post-approval (item icon auto-resolution via `itemId === briefId`) |

## Observe before done

Generation runs remotely via GitHub Actions (`asset-request.yml`). Visual review of generated candidates will happen in the sprite-judge step after the workflow completes. No local observation is possible at this stage (Azure credentials not available locally by design).

## Next steps for successor agent

1. Trigger `asset-request` workflow on issue #1308 via issue event (label/edit) or `workflow_dispatch`. The workflow ingests the issue body's brief selection and synthesizes a `briefs/draft/...` brief (does not load committed `chain-flail.yaml` directly).
2. Monitor the workflow run; once complete, run `sprite-judge` skill on the generated candidates.
3. Approve winning variant with `npm run sprites:approve`.
4. Check in with `npm run sprites:checkin` → triggers `asset-checkin` issue.
5. Batch into floor2-bludgeon asset PR via `asset-pr` skill.
6. After art PR merges, wire the runtime key `equipment/weapon/chain-flail` (item icon should auto-resolve if `itemId === briefId`).
