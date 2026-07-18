# Handoff: Asset request `scavenger-harness` (#1377)

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

1🍎 estimated, 1🍎 actual (exact) — art-surface update for one Floor 2 equipment icon plus manifest/catalog registration.

## What changed

- Added a new item brief: `briefs/items/scavenger-harness.yaml` (Floor 2 torso equipment, runtime key `equipment/torso/scavenger-harness`).
- Added generated asset PNG: `public/assets/generated/scavenger-harness-var-0.png` (64×64 RGBA, centered cross/harness-strap silhouette, 39.5% opaque, all alpha binary).
- Registered the approved sprite in `public/assets/generated/manifest.json` as `scavenger-harness-var-0` (`briefId: scavenger-harness`, sensor 7/7, anchor derived at `{x:32, y:56}`).
- Added catalog entry in `src/shared/data/sprite-catalog.json` as `generated:scavenger-harness-var-0`.

## Generation method

Azure OpenAI credentials are not available in the Copilot cloud agent runner environment (the `setup-azure-env.ps1` script detects CI and skips credential bootstrap). The image was therefore generated locally as a minimal synthetic 64×64 PNG (cross/harness shape) following the established precedent set by the `shadow-boots` session (#1386). The `sourceRun` field is marked `…-manual` to flag this as a synthetic stand-in.

The sprite passes all 7 deterministic sensors:

- `dimensions-exact` ✓ — 64×64 matches item type default
- `alpha-binary` ✓ — all pixels either alpha 0 or 255
- `palette-membership` ✓ — paletteMode is 'none', no snapping required
- `opaque-bbox-fits` ✓ — subject fully inside frame, no edge clipping
- `opaque-ratio` ✓ — 39.5% (within 10–65% range)
- `interior-transparency-holes` ✓ — no holes in silhouette
- `anchor-derivable` ✓ — anchor derived at `{x:32, y:56}` (bottom-centre)

VLM judge: not run (Constitutional §3 — CI environment, judge is local-only).

## Identity

- Brief ID: `scavenger-harness`
- Sprite name / manifest key / texture key: `scavenger-harness-var-0`
- Asset path: `generated/scavenger-harness-var-0.png`
- Production wave: `floor2-equipment-ui-torso`
- Stable ID: `torso.scavenger-harness`
- Runtime key: `equipment/torso/scavenger-harness`

## Verification

- `npm run verify:fast`: **pass** (1260 tests, all sprite unit tests pass).
- Sensor run via `scoreCandidate` in the session: **7/7 PASS**.
- Manual eyeball: cross/plus shape is centered, no edge pixels, transparent background.

## Unresolved / known limitations

- **Synthetic PNG only** — the sprite is a minimal silhouette placeholder, not a real Azure-generated pixel-art sprite. A follow-up run through the proper asset-request workflow (issue #1377 re-triggered via workflow_dispatch) will produce the intended grungy, styled artwork.
- DNS proxy blocks direct GitHub API calls, so plan comment on issue #1377 could not be posted from this session.

## Next steps

1. Merge this PR to register the runtime key in the manifest / catalog.
2. Re-trigger the `asset-request.yml` workflow (or reopen issue #1377 to fire a `labeled` event) to generate a proper Azure-rendered sprite and supersede `scavenger-harness-var-0` with a better variant.
