# Handoff: Tinker Grips sprite asset

## Date

2026-07-19

## Persona

Graphics Designer / Asset Forge

## Issue

#1381 — Asset request: tinker-grips

## Aggregate tracking

#1303 — Floor 2 equipment art epic

## Systems touched

- `briefs/items/tinker-grips.yaml` — new item brief (handwear, Floor 2)
- `public/assets/generated/equipment/hands/tinker-grips.png` — approved 64×64 handwear equipment icon
- `public/assets/generated/tinker-grips-var-0.png` — standard approve output (kept for pipeline artifact)
- `public/assets/generated/manifest.json` — upserted entry keyed by stable runtime key `equipment/hands/tinker-grips`
- `src/shared/data/sprite-catalog.json` — catalog entry for runtime resolution
- `tests/integration/generated-manifest-engine.test.ts` — integration assertion for runtime key resolution

## Apples

- Estimate: 1🍎 (pure art asset, no engine gameplay code)
- Actual: 1🍎

## Summary

- Azure sidecar is credential-blocked in this CI environment (`CI=true`, no
  `AZURE_OPENAI_API_KEY`). Per the precedent of PRs #1366 (bone-saw), #1522
  (boarding-axe), and tower-spear, a **hand-authored canary PNG** was built that
  passes all 7 deterministic item sensors.
- The brief at `briefs/items/tinker-grips.yaml` is in place for AI regeneration
  via the `asset-request` GitHub Actions workflow when Azure credentials are available.
- Created a 64×64 pixel art mechanical handwear icon: two compact workshop grips
  side-by-side, featuring iron knuckle plates, segmented finger guards, leather
  cuffs with hex-bolt accents, and brass rivet details. Colors from the
  `kenney-roguelike` palette: gunmetal grey (M=135,135,135), dark grey shadow
  (D=92,92,92), light highlight (L=200,200,200), dark leather (LB=103,68,46),
  lighter leather (LT=141,102,64), brass rivets (BR=159,124,77), rust accent
  (RU=149,92,24), near-black outline (O=68,68,68).
- Ran `npm run sprites:approve` to write the PNG and initial manifest entry.
- Promoted the manifest key from `tinker-grips-var-0` to the stable runtime key
  `equipment/hands/tinker-grips`, following the bone-saw/tower-spear pattern.
- Added `equipment` metadata block (stableId: `hands.tinker-grips`, runtimeKey,
  category: `armor`, family: `handwear`, slot: `hands`, productionWaveId:
  `floor2-equipment-ui-hands`) to the manifest entry.
- Ran `npm run sprites:sync-catalog` to regenerate catalog with proper formatting.
- Integration test asserts the shipped manifest resolves and preloads the exact
  `equipment/hands/tinker-grips` key and asset path.

## Sensor results

All 7/7 item sensors passed on the approved candidate:

- `dimensions-exact` ✅ (64×64)
- `alpha-binary` ✅ (no partial alpha)
- `palette-membership` ✅ (paletteMode='none', auto-pass)
- `opaque-bbox-fits` ✅ (bbox x=[17,47] y=[23,62], fits within 63×63)
- `opaque-ratio` ✅ (23.0% — within 10%–65% range)
- `interior-transparency-holes` ✅ (no enclosed transparent regions)
- `anchor-derivable` ✅ (derived anchor at x=40, y=62 — bottom row, within ±8 of center)

## Before / after observation

- **Before:** `equipment/hands/tinker-grips` did not exist in the manifest, catalog,
  or on-disk asset tree. The runtime key was unresolvable — the equipment panel
  would fall back to placeholder or text rendering.
- **After:** `public/assets/generated/equipment/hands/tinker-grips.png` is on disk;
  `public/assets/generated/manifest.json` carries the entry keyed by
  `equipment/hands/tinker-grips`; `sprite-catalog.json` has the catalog entry;
  the integration test loads the real manifest and asserts the key resolves and
  preloads the correct URL.

## Validation

- All 7 item sensors: ✅ 7/7 passed
- `npm run verify:fast` — 361 unit + 89 integration test files, all passed
- Integration test: `tests/integration/generated-manifest-engine.test.ts`
  - "loads and preloads the shipped Floor 2 tinker-grips runtime key from the real manifest" ✅

## Known limitations / deviations

- Hand-authored pixel art (not Azure AI-generated). The brief is committed for
  AI regeneration via the `asset-request` workflow when Azure credentials are available.
- VLM judge not run (CI blocks judge per Constitutional §3; `SPRITES_ALLOW_CI_PIPELINE`
  bypass applies only to the asset-request workflow worker, not the coding agent).
- `npm run sprites:checkin` and `npm run sprites:asset-pr` are CI-blocked. The PR
  is opened directly from the current working branch (same pattern as #1366).
