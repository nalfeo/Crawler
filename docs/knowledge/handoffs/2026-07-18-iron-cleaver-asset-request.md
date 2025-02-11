# Handoff: iron-cleaver asset request

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

Estimated 🍎, actual 🍎.

## What changed

- Added a new generated asset icon at
  `public/assets/generated/equipment/weapon/iron-cleaver.png` as a centered white
  cleaver silhouette on a transparent 128×128 canvas.
- Added a generated-manifest entry keyed by the exact runtime key
  `equipment/weapon/iron-cleaver` in
  `public/assets/generated/manifest.json`, pointing to the new asset path.
- Added a focused regression test
  `tests/unit/iron-cleaver-asset-request.test.ts` that asserts:
  1. the exact runtime key exists in the manifest, and
  2. the shipped icon file exists with centered opaque silhouette pixels.

## Verification

- `npx vitest run tests/unit/iron-cleaver-asset-request.test.ts`
- `npx vitest run tests/unit/generated-asset-registry.test.ts tests/unit/sprites/asset-plan.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-iron-cleaver-asset-request.review-ledger.json`

## Unresolved issues

- Could not post the requested pre-code plan comment directly to GitHub issue #1315
  from this environment (`gh issue comment` returns HTTP 403 GraphQL forbidden).
