# Handoff: hunting-bola runtime-key icon

## Date

2026-07-19

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

Estimated 1🍎, actual 1🍎.

## Summary

- Added a generated Floor 2 hunting-bola weapon icon at:
  - `public/assets/generated/equipment/weapon/hunting-bola-placeholder.png`
- Added a generated-manifest entry keyed by the exact runtime key:
  - `equipment/weapon/hunting-bola`
- Preserved required equipment metadata in manifest:
  - `stableId: weapon.hunting-bola`
  - `runtimeKey: equipment/weapon/hunting-bola`
  - `productionWaveId: floor2-equipment-weapon-bow`
- Added a focused regression test:
  - `tests/unit/hunting-bola-asset-request.test.ts`

## Verification run

- `npx vitest run tests/unit/hunting-bola-asset-request.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-19-hunting-bola-asset-request.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- Could not post the requested pre-code plan comment on issue #1344 from this environment because GitHub API auth is blocked (`gh issue comment` returned HTTP 403).

## Recommended next steps

1. If needed for strict process traceability, post the same implementation plan to issue #1344 from a GitHub-authenticated environment.
