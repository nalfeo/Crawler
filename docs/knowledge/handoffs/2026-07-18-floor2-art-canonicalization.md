# Handoff: Floor 2 equipment art canonicalization

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, inventory

## Apples

Estimated 2 apples, actual 2 apples (exact).

## Authority and stack

- Issue: #1560
- Branch: `nalfeo-fix-floor2-art-canonicalization`
- Base branch: `nalfeo-floor-2-equipment-placeholders`
- Verified local HEAD, fetched remote base, and merge-base before implementation:
  `5ba2bf475fb3fb6bd3c38ef8c726d7ca72f344e1`

## Summary

- Derived the exact 70 bare Floor 2 equipment art identities from
  `FLOOR2_EQUIPMENT_ART_DEFINITIONS`; no identity keys are duplicated in a second
  authored list.
- Added those reserved identities to `itemArtIdentitySet()` so production approval
  strips a trailing generation `-vN` before gameplay catalogs land.
- Preserved the existing harvestable exclusion after all identity additions.
  Enemies, tiles, props, harvestable world nodes, and unknown concepts remain
  versioned.
- Added complete 70-key coverage, representative weapon/UI cases, negative
  non-item cases, and a filesystem-level `approveVariant()` regression.
- Did not approve or check in art, mutate asset issues or queues, change stable IDs,
  gameplay, the Floor 2 equipment PLAN, or epic state.

## Observation

At the exact supplied base, `bone-saw` was absent from the approval identity set,
so `bone-saw-v1` flowed through `approveVariant()` as
`bone-saw-v1-var-1`. The regression test now copies a synthetic immutable
`bone-saw-v1` run through the real approval API and observes one consistent bare
consumer identity: manifest key and engine texture key `bone-saw-var-1`,
`briefId: bone-saw`, `spriteName: bone-saw-var-1`, catalog ID
`generated:bone-saw-var-1`, and asset path `generated/bone-saw-var-1.png`. The
copied summary and processed PNG remain byte-identical.

## Validation

- Focused canonicalization and approval tests: 66 passed.
- `npm run verify:fast`: passed.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-18-floor2-art-canonicalization.review-ledger.json`
  validates as a 2-apple ledger with no required review stages.
- Guard telemetry source did not exist, so no telemetry artifact was required.
