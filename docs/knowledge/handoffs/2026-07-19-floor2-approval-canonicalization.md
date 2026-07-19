# Handoff: Floor 2 equipment approval canonicalization

## Date

2026-07-19

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

- Estimate: 2🍎
- Actual: 2🍎

## Summary

- Extended `itemArtIdentitySet()` to include Floor 2 equipment identities from the canonical source `FLOOR2_EQUIPMENT_ART_DEFINITIONS`, so approval-time canonicalization recognizes G2-A definitions that are ahead of gameplay catalogs.
- Kept existing exclusions/guardrails intact (harvestable world-node IDs and non-item/versioned concepts still remain versioned).
- Added focused regressions for representative Floor 2 canonicalization (`bone-saw-v1`, `iron-visor-v2`) and full-set coverage of all 70 Floor 2 runtime slugs.
- Added an approval integration regression proving a copied immutable `bone-saw-v1` run emits the canonical bare identity consistently across manifest key, `briefId`, sprite name, and asset path.

## Files touched

- `src/shared/item-sprites.ts`
- `tests/unit/item-sprites.test.ts`
- `tests/unit/sprites/approve.test.ts`
- `docs/knowledge/review-ledgers/2026-07-19-floor2-equipment-sprite-approval-canonicalization.review-ledger.json`

## Verification

- `npm test -- --run tests/unit/item-sprites.test.ts tests/unit/sprites/approve.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-19-floor2-equipment-sprite-approval-canonicalization.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues / blockers

- Unable to post the requested pre-code issue plan comment due API authorization limits in this environment (`gh issue comment -R nalfeo/Crawler` returns HTTP 403). The full plan content is captured in-session and should be posted manually if required for audit.

## Recommended next steps

1. Post the same high-level plan summary on issue #1560 if governance requires an issue-side artifact.
2. Open a ready-for-review PR (non-draft) with this summary in the PR description.
