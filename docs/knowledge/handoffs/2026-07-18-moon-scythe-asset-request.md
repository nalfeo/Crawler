# Handoff: moon-scythe asset request

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, generated-assets

## Apples

2🍎 exact — art-only asset addition: brief + generated asset + manifest metadata, no gameplay/code changes.

## What Was Done

Handled issue #1325 for the `moon-scythe` Floor 2 equipment icon:

1. **Authored source brief**: Added `/home/runner/work/Crawler/Crawler/briefs/weapons/moon-scythe.yaml` with a centered, moon-themed scythe description that preserves the requested silhouette/readability constraints.
2. **Checked in runtime asset**: Added `/home/runner/work/Crawler/Crawler/public/assets/generated/equipment/weapon/moon-scythe.png` as the transparent-background icon asset.
3. **Preserved exact runtime key**: Added a new manifest entry under `equipment/weapon/moon-scythe` in `/home/runner/work/Crawler/Crawler/public/assets/generated/manifest.json` with the correct stable ID (`weapon.moon-scythe`) and production wave (`floor2-equipment-weapon-magic-focus`).
4. **Validated manifest/runtime surface**: Parsed the updated generated manifest successfully and confirmed the dev server serves `http://127.0.0.1:4173/assets/generated/equipment/weapon/moon-scythe.png` with HTTP 200 and the expected SHA-256 (`4fd795466d0eb0480e0667510313e77d5ca05cc36b1a64855343cadb3b8f7a33`).
5. **verify:fast passed**: Fast verification completed successfully after the change set.

Observed before/after:

- **Before**: this branch had no `moon-scythe` brief, no checked-in `public/assets/generated/equipment/weapon/moon-scythe.png`, and no `equipment/weapon/moon-scythe` manifest entry.
- **After**: the runtime key resolves in the generated manifest and the asset is served from the running Vite artifact.

## Key Decisions Made

- **Kept the runtime key exact**: used `equipment/weapon/moon-scythe` directly as the manifest identity instead of introducing a variant-suffixed or renamed runtime-facing key.
- **Used honest manual metadata**: the local environment lacked Azure sprite credentials and the GitHub issue-comment API path was blocked by the DNS proxy, so the manifest records `sourceRun: manual-authored/moon-scythe` / `sensorScore: manual-authored` instead of pretending this was an Azure-approved pipeline run.
- **Did not pull the whole Floor 2 placeholder branch into this PR**: the epic source-of-truth branch `origin/nalfeo-floor-2-equipment-placeholders` already contains broader placeholder groundwork, but this issue slice stayed limited to the single requested asset/runtime key.

## What's Next / Blockers

- I attempted to post the required pre-code plan comment to the GitHub issue, but direct GitHub write APIs from this environment returned `403 Blocked by DNS monitoring proxy`. The plan summary should still be mirrored into the PR description.
- If maintainers want this asset to be re-run through the full Azure sprite workflow later, the added brief provides a source prompt to regenerate from once credentials are available.

## Retrospective

### Lessons Learned

- The Floor 2 equipment source-of-truth data currently lives on `origin/nalfeo-floor-2-equipment-placeholders`, not in this branch’s base `main`, so single-asset issue work can require checking that branch before assuming a runtime key is missing project-wide.
- For art-only asset additions, manifest validation plus a served-asset hash check is a useful deterministic runtime sanity check even when a full sprite-generation run is unavailable locally.
