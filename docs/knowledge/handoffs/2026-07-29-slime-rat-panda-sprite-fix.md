# Slime Rat Panda Sprite Fix

**Date:** 2026-07-29  
**Issue:** #2299 — "Why is the slime rat a panda?"  
**Apple estimate:** 1🍎 (pure art asset correction, no code changes)

## Summary

Fixed a cyclic PNG swap bug introduced by the manifest-sharding PR (#2286). Three boss
sprite PNGs were committed to incorrect paths, causing the Floor 1 Slime Rat boss to
render as a panda.

## Root Cause

When PR #2286 committed the individual shard PNG files for the first time, the content of
three boss sprites were cyclically misassigned to the wrong filenames:

| File (before fix)          | Content                                | Expected content   |
| -------------------------- | -------------------------------------- | ------------------ |
| `slime-rat-boss-var-1.png` | Panda image 🐼                         | Slime-rat hybrid   |
| `panda-boss-var-0.png`     | Don Honkrado goose (crime-boss fedora) | Panda              |
| `geese-boss-var-0.png`     | Dark creature                          | Don Honkrado goose |

The content hashes in the JSON entries matched the (wrong) PNG files, so integrity checks
passed. The manifest assembly logic and rendering pipeline were correct — only the
physical PNG file content was wrong.

## Fix

Performed a 3-way cyclic PNG swap to assign each image to the correct path:

| File (after fix)           | Content            | Status                                         |
| -------------------------- | ------------------ | ---------------------------------------------- |
| `panda-boss-var-0.png`     | Panda image 🐼     | ✓ Correct for `panda-boss` brief               |
| `geese-boss-var-0.png`     | Don Honkrado goose | ✓ Matches catalog description                  |
| `slime-rat-boss-var-1.png` | Dark creature      | ⚠️ Stopgap — still needs correct slime-rat art |

Each shard JSON entry's image-specific metadata was updated to match the newly-assigned
PNG content:

- `contentHash` (SHA256 of the PNG)
- `anchor` / `anchors`
- `sensorScore`, `judgeScore`
- `opaqueBounds`

Brief-specific metadata (briefId, spriteName, assetPath, sourceRun, approvedAt,
variantIndex, catalog.description) was preserved in each entry.

## Systems Touched

sprite-pipeline

## Files Touched

- `public/assets/generated/slime-rat-boss-var-1.png`
- `public/assets/generated/panda-boss-var-0.png`
- `public/assets/generated/geese-boss-var-0.png`
- `public/assets/generated/entries/slime-rat-boss-var-1.json`
- `public/assets/generated/entries/panda-boss-var-0.json`
- `public/assets/generated/entries/geese-boss-var-0.json`

## Verification Run

- 50 unit tests in `tests/unit/phaser-bridge.test.ts` — all pass
- 22 integration tests in `tests/integration/generated-manifest-engine.test.ts` — all pass
- All 6 PNG SHA256 hashes cross-verified against JSON `contentHash` fields

## Unresolved Issues

**`slime-rat-boss-var-1.png` still shows a dark creature (not a slime-rat hybrid).** The
original slime-rat-boss art was never correctly generated (or was lost). The dark creature
image was placed here as a stopgap to avoid showing a panda. New correct slime-rat-boss art
should be commissioned via the asset pipeline.

To generate correct art: run the `slime-rat-boss` brief through `npm run sprites:run` and
approve a variant that depicts a slime-covered rat hybrid. Then update
`public/assets/generated/entries/slime-rat-boss-var-1.json` and the PNG accordingly.

## Recommended Next Steps

1. Commission new slime-rat-boss art: brief should describe a rat-slime hybrid boss
   fitting Floor 1 dungeon aesthetic
2. Check other boss sprites in the batch for similar cyclic swap issues (panda-bruiser,
   geese-honker were also committed in the same PR)
