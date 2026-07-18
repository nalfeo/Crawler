# 2026-07-18 — dueling-saber sprite (issue #1311)

**Session type:** Asset Forge — Graphics Designer persona  
**Apple estimate:** 1-2 🍎 (pure art wave, review-ledger-exempt)  
**Date:** 2026-07-18

## Summary

Generated the dueling-saber weapon icon for Floor 2 equipment via the Azure
sidecar pipeline. Brief authored, generation triggered and completed, art now
in Azure blob store awaiting checkin.

## Systems touched

- `briefs/weapons/dueling-saber.yaml` — authored canonical brief (vertical orientation,
  swept guard, 3–4 steel color stops, dungeon-worn)
- Azure pipeline: generation completed via asset-request workflow (run #260)

## Generation details

| Field                         | Value                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Brief (authored)              | `briefs/weapons/dueling-saber.yaml`                                                                                      |
| Brief (synthesized by worker) | `briefs/draft/weapons/dueling-saber.yaml` → `dueling-saber-v1`                                                           |
| Run ID                        | `2026-07-18T01-23-51-9682f542`                                                                                           |
| Run summary                   | `https://crawlersprites.blob.core.windows.net/generated-runs/dueling-saber-v1/2026-07-18T01-23-51-9682f542/summary.json` |
| GitHub issue                  | #1311                                                                                                                    |
| Stable ID                     | `weapon.dueling-saber`                                                                                                   |
| Runtime key                   | `equipment/weapon/dueling-saber`                                                                                         |

### Pipeline stage comments on issue #1311

1. 🎬 Queued (01:19 UTC)
2. 🧪 Started synthesis (01:23 UTC)
3. 🧠 Selected candidate 1/3 (jagged scrap-metal saber with car door handle hilt)
4. 📌 Promoted to `briefs/draft/weapons/dueling-saber.yaml`
5. ✅ Pipeline complete (01:25 UTC)

## What was NOT done in this session (CI constraints)

This session ran in a GitHub Actions CI environment (`CI=true`) which
Constitutional §3 guards prevent from running:

- `npm run sprites:checkin` — requires non-CI (local dev)
- `npm run sprites:asset-pr` — requires non-CI (local dev)
- Azure blob download blocked by runner network restrictions

The generated art is in Azure blob at:
`dueling-saber-v1/2026-07-18T01-23-51-9682f542/`

## Next steps

1. **Checkin:** A non-CI session (dev workstation or dedicated runner with
   Azure creds + `CI` unset) should run:

   ```bash
   # Pull the run from Azure blob store (sidecar approach) or:
   npm run sprites:checkin
   npm run sprites:asset-pr
   ```

2. **Or:** Re-trigger the generation if the art quality needs review.
   The authored brief in `briefs/weapons/dueling-saber.yaml` is the canonical
   art direction; the synthesized `dueling-saber-v1` brief used a "jagged
   scrap-metal with car door handle" aesthetic — consider whether that matches
   the Floor 2 equipment tone.

## Art direction notes

The authored brief (`briefs/weapons/dueling-saber.yaml`) specifies:

- **Elegant curved blade** — thin highlight along back edge, deep shadow on flat
- **Swept knuckle guard** — iron-grey, small but readable
- **Dark brown leather grip** — wrapped, small rounded pommel
- **Dungeon-worn** — edge nicks, scuffs, not pristine
- **Vertical orientation** — grip at bottom center, tip at top

The synthesized brief went with "jagged scrap-metal saber / car door handle hilt"
which is a more Floor-1 aesthetic. For Floor 2 equipment, the authored brief may
produce better results on regeneration.

## Observe before done

Before claiming this fully done:

- Check the generated sheet (download from Azure blob or via sidecar lab)
- Verify the winner passes all weapon sensors (orientation vertical ±5°, anchor derived)
- Confirm the PNG reads as a saber at 64×64
- Compare against existing weapon siblings in the registry

## Judge verdict

Not obtained in this session (VLM judge refused in CI, Azure blob not accessible).
Must be done in a non-CI sidecar session before final approval.
