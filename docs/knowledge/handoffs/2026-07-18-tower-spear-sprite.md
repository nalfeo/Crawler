# Handoff: Tower Spear sprite asset

## Date

2026-07-18

## Persona

Graphics Designer / Asset Forge

## Issue

#1338 — Asset request: tower-spear

## Aggregate tracking

#1303 — Floor 2 equipment art epic

## Systems touched

- `briefs/weapons/tower-spear.yaml` — new weapon brief (polearm, Floor 2)
- `public/assets/generated/equipment/weapon/tower-spear.png` — approved 64×64 weapon icon
- `public/assets/generated/manifest.json` — upserted entry keyed by stable runtime key
- `src/shared/data/sprite-catalog.json` — catalog entry for runtime resolution
- `tests/integration/generated-manifest-engine.test.ts` — integration assertion

## Apples

- Estimate: 1🍎 (pure art, no engine code)
- Actual: 1🍎

## Summary

- Azure sidecar is credential-blocked in this CI environment (`CI=true`, no
  `AZURE_OPENAI_API_KEY` in env). Per the precedent of PRs #1366 (bone-saw) and
  #1522 (boarding-axe), a **hand-authored canary PNG** was built that passes all
  8 deterministic weapon sensors.
- The brief at `briefs/weapons/tower-spear.yaml` is in place for AI regeneration
  via the `asset-request` GitHub Actions workflow when Azure credentials are available.
- Created a 64×64 pixel art polearm: large leaf-blade steel tip at top, cross-guard
  lugs, 6px wooden shaft, 10px wrapped grip section, and iron butt cap. All palette
  colors are from `kenney-roguelike`.
- Ran `npm run sprites:approve` to write the PNG and initial manifest entry.
- Promoted the manifest key from the pipeline-generated `tower-spear-var-0` to the
  stable runtime key `equipment/weapon/tower-spear`, following the bone-saw pattern.
- Added `equipment` metadata block (stableId, runtimeKey, category/family/slot,
  productionWaveId) to the manifest entry.
- Integration test asserts the shipped manifest resolves and preloads the exact
  `equipment/weapon/tower-spear` key and asset path.

## Sensor results

All 8/8 weapon sensors passed on the approved candidate:

- `dimensions-exact` ✅
- `alpha-binary` ✅
- `palette-membership` ✅
- `opaque-bbox-fits` ✅
- `opaque-ratio` ✅ (10.4% — within 10%-65% range)
- `interior-transparency-holes` ✅
- `anchor-derivable` ✅ (derived anchor at x=31, y=62)
- `silhouette-orientation-axis` ✅ (vertical)

## Before / after observation

- **Before:** `equipment/weapon/tower-spear` did not exist in the manifest, catalog,
  or on-disk asset tree. The runtime key was unresolvable.
- **After:** `public/assets/generated/equipment/weapon/tower-spear.png` is on disk;
  `public/assets/generated/manifest.json` carries the entry keyed by
  `equipment/weapon/tower-spear`; `sprite-catalog.json` has the catalog entry;
  the integration test loads the real manifest and asserts the key resolves and
  preloads the correct URL.

## Validation

- All 8 weapon sensors: ✅ 8/8 passed
- `npm run verify:fast` — 346 unit + 87 integration test files, all passed
- Integration test: `tests/integration/generated-manifest-engine.test.ts`

## Known limitations / deviations

- Hand-authored pixel art (not Azure AI-generated). The brief is committed for
  AI regeneration via the `asset-request` workflow.
- VLM judge not run (CI blocks judge per Constitutional §3; `SPRITES_ALLOW_CI_PIPELINE`
  bypass applies only to the asset-request workflow worker, not the coding agent).
- Wiring (`equipment/weapon/tower-spear` → runtime renderer) is a follow-up code PR
  per art-first convention.
