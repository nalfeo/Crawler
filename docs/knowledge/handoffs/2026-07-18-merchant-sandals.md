# Handoff: merchant-sandals asset request

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

Estimated 2 apples (🍎🍎), actual 2 apples (🍎🍎).

## What changed

- Added the committed item brief `briefs/items/merchant-sandals.yaml` using the
  exact `merchant-sandals` slug so the art stays aligned to the Floor 2 stable
  equipment key family (`equipment/feet/merchant-sandals`).
- Added a checked-in transparent 64×64 sprite asset at
  `public/assets/generated/merchant-sandals-var-0.png`: a centered paired-sandal
  silhouette with worn leather soles, crossing straps, and small brass accents.
- Registered the asset in the shipped generated-art manifest and sprite catalog:
  - `public/assets/generated/manifest.json`
  - `src/shared/data/sprite-catalog.json`

## Observe-before-done

- Before: no `merchant-sandals` brief, PNG, manifest entry, or sprite-catalog
  record existed in the repository.
- After:
  - the shipped manifest/catalog parse cleanly and the generated-asset registry
    tests pass with the new entry;
  - the normal dev server serves
    `http://127.0.0.1:4173/assets/generated/merchant-sandals-var-0.png` with
    HTTP 200;
  - the authored PNG's opaque bbox is fully in-frame and centered enough for a
    slot icon (`minX=11 maxX=52 minY=16 maxY=50`, center `31.5,33`).

## Verification

- `npx vitest run tests/integration/generated-manifest-engine.test.ts tests/unit/generated-asset-registry.test.ts`
- `npm run verify:fast`
- `curl -I http://127.0.0.1:4173/assets/generated/merchant-sandals-var-0.png`

## Environment blockers / deviations

- The required pre-code GitHub issue plan comment was prepared and attempted
  twice, but this session's GitHub auth was invalid for API writes
  (`gh issue comment` returned a host-resolution failure via the local mirror and
  then `HTTP 403` against `nalfeo/Crawler`). The plan text lived in-session, but
  could not be posted from this environment.
- The normal Azure sprite generator path was unavailable here:
  `npm run sprites:run -- --brief briefs/items/merchant-sandals.yaml` failed on
  missing `AZURE_OPENAI_ENDPOINT`, and `npm run setup:azure:env` is a no-op in
  this cloud environment. To still land the requested asset in-repo, the final
  PNG was authored locally and then checked into the normal generated-art
  manifest/catalog.

## Unresolved issues

- None in-repo. The only unresolved items are the environment-level GitHub write
  permission block for issue commenting and the missing Azure sprite credentials
  for a pipeline-generated variant.
