# 2026-07-18 — venom-dirk weapon brief (issue #1326)

**Date:** 2026-07-18  
**Apple estimate:** 1🍎 (art-only lane)  
**Status:** ✅ Brief committed; ✅ Azure pipeline completed twice; ⏳ Check-in pending (local-only step)  
**Issue:** nalfeo/Crawler#1326  
**Branch:** `copilot/create-venom-dirk-icon`

## What was done

1. **Persona adopted:** Graphics Designer (`docs/agent-os/personas/graphics-designer.md`)
2. **Style guide read:** `docs/agent-os/sprite-style.md` — vertical weapon, 64×64, kenney-roguelike palette, hard 1-pixel outlines, bold venom theme via palette not effects.
3. **Brief authored** at `briefs/weapons/venom-dirk.yaml`:
   - `name: venom-dirk` (bare, not versioned — item icons resolve by bare id per ADR 0051)
   - `type: weapon`, vertical orientation (default from `weapon.json`)
   - 64×64, anchor `{x:32, y:56}` (grip-bottom center, inherited)
   - Description: narrow dirk, dark slate/purple blade with sickly venom-green tinge along fuller, dark purple corrosion patches, dark leather grip, no glow/dripping effects
   - `minVariations: 8` with 2 seed variations
   - VLM judge enabled (inherited from `weapon.json`)
4. **Brief validated** — loads correctly, passes Zod schema, all defaults inherited from `data/sprite-types/weapon.json`
5. **`verify:fast` passed** — all 1260 tests green, no regressions
6. **Brief committed and pushed** to `copilot/create-venom-dirk-icon`

## Azure pipeline status

The `asset-request.yml` GitHub Actions workflow ran twice on issue #1326 and **both completed successfully**:

| Run | Timestamp                      | Brief ID        | Status      |
| --- | ------------------------------ | --------------- | ----------- |
| 1   | `2026-07-18T01-21-05-492291b3` | `venom-dirk-v1` | ✅ Complete |
| 2   | `2026-07-18T03-35-59-750212e2` | `venom-dirk-v1` | ✅ Complete |

The generated sprites are stored in Azure blob storage at:

- `generated-runs/venom-dirk-v1/2026-07-18T03-35-59-750212e2/` (most recent)

VLM judge selected candidate 1/3: _"jagged-edged blade with thorn-like projection and bat-wing guard, strong dark-fantasy silhouette, venomous theme, floor-appropriate weirdness."_

The check-in step (`npm run sprites:checkin`) is **intentionally blocked in CI** per Constitutional §3. It must run on a dev box with Azure credentials to commit the PNG and create the `asset-checkin` issue.

## Systems touched

- `briefs/weapons/venom-dirk.yaml` — new canonical brief (art lane, no wiring)

## What remains

For the maintainer (requires local dev box with Azure credentials):

1. **Check in the generated sprite:**

   ```bash
   npm run sprites:checkin
   ```

   This downloads the approved `venom-dirk-v1` run from Azure, commits the PNG + manifest update + catalog update to a new `assets/checkin-*` branch, and creates an `asset-checkin` issue.

2. **Asset PR:** use the `asset-pr` skill to batch all open `asset-checkin` issues into one art-only PR that closes issue #1326.

3. **Observe:** Confirm `equipment/weapon/venom-dirk` resolves to real art in `npm run dev`.

Alternatively, if a new generation is preferred using the canonical authored brief:

```bash
npm run sprites:run -- --brief briefs/weapons/venom-dirk.yaml
# Judge, approve, checkin as above
```

This will produce a `venom-dirk` (not `venom-dirk-v1`) manifest entry, which is cleaner but requires the normalization pass to work correctly.

## Key brief decisions

- **Name is bare `venom-dirk`, not `venom-dirk-v1`:** Item icon resolution (ADR 0051) uses `TIER_BARE_REAL=0` which wins over `TIER_VERSIONED_REAL=1`. A bare brief ID keeps the manifest key clean and avoids needing a normalization pass.
- **No orientation override:** The dirk is a true vertical blade (point up, grip down) — default `weapon.json` orientation is correct.
- **Venom theme via palette only:** Dark purples and sickly greens in the blade material, no floating droplets or glow effects (those would fail sensors and read poorly at game scale).
- **Brief note re issue pipeline name mismatch:** If the `asset-request.yml` CI workflow re-runs on the issue, it will still synthesize `venom-dirk-v1` briefs. Using this committed brief directly with `sprites:run` avoids that mismatch.
