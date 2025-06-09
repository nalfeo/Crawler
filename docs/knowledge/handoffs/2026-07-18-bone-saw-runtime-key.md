# Handoff: Bone Saw runtime-key promotion

## Date

2026-07-18

## Persona

Graphics Designer / Asset Forge

## Issue

#1314 — Asset request: bone-saw

## Systems touched

- sprite briefs
- generated-assets manifest
- sprite catalog
- engine generated-asset preload integration test

## Apples

- Estimate: 2🍎
- Actual: 2🍎

## Summary

- Added a committed weapon brief at `briefs/weapons/bone-saw.yaml`.
- Recovered no usable local Azure run artifacts for the issue's recorded run, and this
  session could not rerun the Azure/VLM path (`.env.local` absent, blob DNS unavailable,
  `CI=true` blocks the local-only judge).
- Built a bounded local canary icon, iterated it until the real weapon sensor suite
  passed 8/8, then approved it through `npm run sprites:approve`.
- Promoted the approved PNG into the canonical Floor 2 runtime key
  `equipment/weapon/bone-saw`, updated the generated manifest + sprite catalog to that
  exact key, and removed the transient `bone-saw-var-0` repo artifact so the checked-in
  state exposes only the requested stable key.

## Before / after observation

- Before: repo search had no `bone-saw` hits, so `equipment/weapon/bone-saw` did not
  exist in the checked-in manifest/catalog/runtime loader path.
- After: the real manifest loader / preloader integration test loads
  `equipment/weapon/bone-saw` from `public/assets/generated/manifest.json` and queues
  `/assets/generated/equipment/weapon/bone-saw.png`, proving the shipped engine-facing
  generated-asset path now resolves the stable key.

## Validation

- Deterministic sensors on the approved candidate: **8/8 passed**
  (`dimensions-exact`, `alpha-binary`, `palette-membership`, `opaque-bbox-fits`,
  `opaque-ratio`, `interior-transparency-holes`, `anchor-derivable`,
  `silhouette-orientation-axis`).
- `npm test -- --run tests/integration/generated-manifest-engine.test.ts`
- `npm run verify:fast`

## Known blockers / deviations

- GitHub issue plan comment remained blocked from this session: `gh issue comment` returned
  HTTP 403 against `nalfeo/Crawler`.
- The asset-request workflow's blob summary URL was not recoverable here because
  `crawlersprites.blob.core.windows.net` did not resolve in this environment.
- Because the Azure/VLM rerun path was unavailable in-session, the final accepted
  candidate used deterministic sensors + eyeball review rather than a live VLM judge
  result. No sensor thresholds or gates were weakened.
