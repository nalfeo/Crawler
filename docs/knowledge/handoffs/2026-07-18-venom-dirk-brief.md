# 2026-07-18 — venom-dirk weapon brief (issue #1326)

**Date:** 2026-07-18  
**Apple estimate:** 1🍎 (art-only lane; brief committed, generation pending)  
**Status:** ⏳ Brief committed; sprite generation blocked by missing Azure credentials  
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

## Blocker: Azure credentials not available

The sprite generation pipeline (`npm run sprites:run -- --brief briefs/weapons/venom-dirk.yaml`) requires `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` which are intentionally scoped only to the `asset-request.yml` GitHub Actions workflow (per workflow security comments). Per AGENTS.md §Azure-required sidecar policy, the correct response is to report the blocker and stop.

The GitHub Actions asset-request pipeline has already run **twice** on issue #1326 but both times used the synthesized brief name `venom-dirk-v1` (not `venom-dirk`). Those run artifacts exist in Azure blob storage but cannot be accessed from the coding agent environment.

## Systems touched

- `briefs/weapons/venom-dirk.yaml` — new canonical brief (art lane, no wiring)

## What remains

For whoever has Azure credentials (developer or CI runner):

1. **Generate:**

   ```bash
   npm run sprites:run -- --brief briefs/weapons/venom-dirk.yaml
   ```

   This will produce `generated/runs/venom-dirk/<run-id>/` locally.

2. **Judge** variants using the sprite-judge skill — look at `combinedPassed` in the run output, pick the best passing variant that reads as a stabbing blade at a glance.

3. **Approve:**

   ```bash
   npm run sprites:approve -- generated/runs/venom-dirk/<run-id> --variant <N>
   ```

4. **Check in:**

   ```bash
   npm run sprites:checkin
   ```

   → creates `asset-checkin` issue + art branch

5. **Asset PR:** use the `asset-pr` skill to batch all open `asset-checkin` issues into one art-only PR.

6. **Observe:** Confirm `equipment/weapon/venom-dirk` resolves to real art in `npm run dev`.

## Key brief decisions

- **Name is bare `venom-dirk`, not `venom-dirk-v1`:** Item icon resolution (ADR 0051) uses `TIER_BARE_REAL=0` which wins over `TIER_VERSIONED_REAL=1`. A bare brief ID keeps the manifest key clean and avoids needing a normalization pass.
- **No orientation override:** The dirk is a true vertical blade (point up, grip down) — default `weapon.json` orientation is correct.
- **Venom theme via palette only:** Dark purples and sickly greens in the blade material, no floating droplets or glow effects (those would fail sensors and read poorly at game scale).
- **Brief note re issue pipeline name mismatch:** If the `asset-request.yml` CI workflow re-runs on the issue, it will still synthesize `venom-dirk-v1` briefs. Using this committed brief directly with `sprites:run` avoids that mismatch.
