# Handoff: chain-flail weapon brief (Floor 2 bludgeon wave)

**Date:** 2026-07-18  
**Agent:** Asset Forge (Graphics Designer persona)  
**Apple estimate:** 1🍎  
**PR:** Closes #1308

## Summary

Authored `briefs/weapons/chain-flail.yaml` for the Floor 2 bludgeon production wave (`floor2-equipment-weapon-bludgeon`). This is a pure art/brief task — no engine code, no registry wiring, no review harness or ledger required.

## Systems touched

None — this is a pure art/brief task. No engine systems were modified. Files changed:

- `briefs/weapons/chain-flail.yaml` — new weapon brief (art asset definition, no runtime code)
- `docs/knowledge/handoffs/2026-07-18-chain-flail-brief.md` — this handoff

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
| Committed + PR opened                              | ✅ closes #1308                                                       |
| Generation (Azure sidecar)                         | ⏳ will trigger via `asset-request` workflow on PR label              |
| Judge / approve / check-in / asset-PR              | ⏳ next wave step after generation                                    |
| Wire to runtime key `equipment/weapon/chain-flail` | ⏳ post-approval (item icon auto-resolution via `itemId === briefId`) |

## Observe before done

Generation runs remotely via GitHub Actions (`asset-request.yml`). Visual review of generated candidates will happen in the sprite-judge step after the workflow completes. No local observation is possible at this stage (Azure credentials not available locally by design).

## Next steps for successor agent

1. Monitor `asset-request` workflow run triggered by PR label on this issue.
2. Once run completes, run `sprite-judge` skill on the generated candidates.
3. Approve winning variant with `npm run sprites:approve`.
4. Check in with `npm run sprites:checkin` → triggers `asset-checkin` issue.
5. Batch into floor2-bludgeon asset PR via `asset-pr` skill.
6. After art PR merges, wire the runtime key `equipment/weapon/chain-flail` (item icon should auto-resolve if `itemId === briefId`).
