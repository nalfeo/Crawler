# Handoff: crescent-glaive asset request

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

Estimated 🍎, actual 🍎. Exact: art-surface-only check-in.

## What changed

- Added the requested Floor 2 crescent glaive icon asset at:
  - `public/assets/generated/equipment/weapon/crescent-glaive-placeholder.png`
- Added a generated-manifest entry keyed by the required runtime key:
  - `equipment/weapon/crescent-glaive`
- Preserved runtime-key identity and metadata in the manifest entry:
  - `runtimeKey: equipment/weapon/crescent-glaive`
  - `stableId: weapon.crescent-glaive`
  - `productionWaveId: floor2-equipment-weapon-polearm`

## Verification

- `npx vitest run tests/unit/generated-asset-preload.test.ts`
- `npx vitest run tests/unit/item-sprites.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs` — passes; review-ledger guard reports the docs/art-only exemption for this change

## Unresolved issues

- Could not post the requested issue plan comment from this workspace because `origin` points at a local mirror (`http://localhost:26831/...`) and `gh` is not authenticated to a GitHub host in this environment.
