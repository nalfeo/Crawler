# Handoff: flame-tongs asset request

**Date:** 2026-07-18  
**Persona:** Graphics Designer  
**Apples:** estimated 1🍎 / actual 1🍎

## Systems touched

sprite-pipeline, sprite-workflow

## Summary

Handled issue #1470 by adding a new generated equipment weapon icon asset for
`flame-tongs`, preserving the stable runtime key shape
`equipment/weapon/flame-tongs`.

## Files touched

- `public/assets/generated/flame-tongs-var-0.png`
- `public/assets/generated/manifest.json`
- `src/shared/data/sprite-catalog.json`
- `briefs/weapons/flame-tongs.yaml`
- `docs/knowledge/handoffs/2026-07-18-flame-tongs-asset-request.md`

## What changed

- Added `flame-tongs-var-0.png` as a centered transparent weapon icon with a
  silhouette-readable crossed-tongs + flame profile.
- Added `manifest.json` entry `flame-tongs-var-0` with:
  - `briefId: "flame-tongs"`
  - `type: "weapon"`
  - asset path `generated/flame-tongs-var-0.png`
  - pinned `contentHash`
- Added a generated sprite-catalog record
  `generated:flame-tongs-var-0` tagged as `weapon/generated/pipeline-approved`.
- Added canonical source brief `briefs/weapons/flame-tongs.yaml` containing the
  issue’s runtime key requirement and icon constraints.

## Verification

- `npx vitest run tests/unit/sprites/sprite-catalog-sync.test.ts tests/integration/generated-manifest-engine.test.ts tests/unit/generated-asset-preload.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs` (initially failed for missing handoff; resolved by adding this file)

## Unresolved issues

- Could not post the required pre-code issue plan comment from this environment:
  both `gh issue comment` attempts returned authorization failures (no writable
  GitHub token / GraphQL 403). This is non-blocking for the asset files in this
  branch, but the maintainer should post the plan comment manually on issue
  #1470 if strict audit-trail compliance is required.
