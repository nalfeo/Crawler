# Handoff: Rune Axe Weapon Brief (Asset Request #1330)

**Date:** 2026-07-18  
**Session slug:** rune-axe-brief  
**Issue:** nalfeo/Crawler#1330  
**Aggregate tracking:** nalfeo/Crawler#1303  
**Production wave:** floor2-equipment-weapon-axe  
**Apples:** 1🍎 (pure art brief — review-ledger-exempt)

## Systems touched

- `briefs/weapons/`

## What was done

Created the brief YAML for the `rune-axe` weapon sprite at
`briefs/weapons/rune-axe.yaml`.

### Brief summary

- **Type:** weapon (inherits 64×64, kenney-roguelike palette, 4×4 sheet, vertical
  orientation, anchor (32,56), VLM judge from `data/sprite-types/weapon.json`)
- **Subject:** one-handed rune axe, vertical orientation, head at top, dark iron/steel
  blade with angular runic glyphs that emit faint cool-blue / violet glow
- **Variations seed (4):** bearded-axe, double-bitted, bone/antler haft accent, wider
  poll with spike + prominent violet glow
- **minVariations: 8** — runner tops up to 8 via Azure chat completions

## Blocker: Azure credentials not available in CI

The sprite generation pipeline (`npm run sprites:run -- --brief
briefs/weapons/rune-axe.yaml`) requires `AZURE_OPENAI_ENDPOINT` and
`AZURE_OPENAI_API_KEY`, which are only accessible as GitHub repository secrets in the
`asset-request.yml` workflow steps — not in the coding agent's CI environment. The
`setup-azure-env.ps1` script explicitly no-ops in CI/Codespaces.

Per AGENTS.md **Azure-required sidecar policy**: "If Azure credentials are missing or
invalid, report the blocker and stop instead of silently falling back."

## Remaining steps (for next session or asset-request workflow)

1. **Generate** — The asset-request workflow (`asset-request.yml`) is the canonical
   path to generate from CI. Trigger it manually:

   ```
   gh workflow run asset-request.yml --repo nalfeo/Crawler
   ```

   Or on a developer workstation with `.env.local`:

   ```
   npm run sprites:run -- --brief briefs/weapons/rune-axe.yaml
   ```

2. **Judge** — Review generated sheets via `sprite-judge` skill. Check
   `combinedPassed` + `.judge.json` per variant. Accept requires: palette ✓,
   alpha-binary ✓, opaque-ratio ✓, anchor ✓, silhouette-axis ✓, judge ≥3/5.

3. **Approve** — `npm run sprites:approve -- <runDir> --variant <N>`

4. **Check in** — `npm run sprites:checkin` (local only — checkin.ts refuses in CI)

5. **Asset PR** — `asset-pr` skill batches all open `asset-checkin` issues into one
   PR that closes #1330.

## Verify

`npm run verify:fast` passes (87 test files, 1260 tests — no brief-schema regressions).

## Observe before done

Not applicable: no sprite was generated, approved, or wired in this session. The
brief is a pure YAML authoring change. The next session that runs generation should
follow the observe-before-done protocol (lab or game render at game scale).
