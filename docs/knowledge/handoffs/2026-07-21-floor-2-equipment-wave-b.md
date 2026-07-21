# Floor 2 equipment content wave B

**Date:** 2026-07-21  
**Branch:** `nalfeo-floor-2-equipment-wave-b`  
**Apple estimate:** 4🍎  
**Actual complexity:** 4🍎

## Systems touched

inventory, weapons, ci-policy

## What was done

- Added exactly 25 generated weapon bases as the deterministic manifest-order
  complement of coordinated Wave A head `a2ccffbb`.
- Added exactly 20 generated armor, accessory, and off-hand bases for canonical
  Floor 2 equipment ordinals 51-70.
- Covered all 10 weapon families and every canonical 18-slot paper-doll
  position.
- Registered the bases in the production weapon/equipment registries with
  deterministic ordering and legal Common/Uncommon/Rare rarity ceilings.
- Added stable placeholder art keys through an optional `artKey` definition
  field while preserving the existing item-ID fallback.
- Kept generated-only base IDs out of `GEAR_ITEM_IDS`, whose lab consumer uses
  static item-catalog insertion and would reject those IDs.
- Added a catalog-backed equipment-ID query for static bag seeders so the
  equipment lab cannot offer generated-only IDs to `addItem`.
- Repaired `test:equipment-gates` so its unit and integration projects run
  separately under their compatible Vitest worker configurations.

## Content boundary

No sprites, asset manifests, briefs, queues, labels, asset issues, asset PRs,
Azure resources, or asset workflows were created or mutated. The existing
Floor 2 art manifest was read only.

## Acceptance evidence

- The Wave B invariant suite checks exact 25/20 counts, canonical ordinal
  ordering, family coverage, all 18 slots, rarity legality, stable art keys,
  registry resolution, and generation of every base at every legal rarity.
- Before this change, Wave B stable IDs had no runtime weapon/equipment
  definitions. After it, all 45 resolve through the production registries and
  generate deterministic instances through the production generator.
- The live Wave A/B roster comparison proves zero overlap and a 50-ID weapon
  union equal to the canonical manifest.
- The authoritative aggregate DPS/distribution gates remain unchanged and
  pass, including the constitutional 1.7x-2.3x per-five-level envelope.

## Validation

- `npm run test:equipment-gates`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-20-floor-2-equipment-wave-b.review-ledger.json`

## Review

- Adversarial plan review by `gpt-5.4` produced a major design fork to the
  manifest-backed 26-70 partition; all six concerns were addressed.
- Code review by `claude-sonnet-4.6` completed cleanly.
- Multi-model review used `claude-sonnet-4.6`, `gpt-5.3-codex`, and
  `gemini-3.1-pro-preview`; `gpt-5.4` adjudicated all three raw concerns as
  non-defects.

## Coordination

Wave A head `a2ccffbb` owns a family-balanced 25-ID roster. Wave B is its
manifest-order complement, and the two rosters form the canonical 50-weapon
set without overlap. Wave A should merge first; Wave B can then rebase onto
main so the combined catalog lands with all 70 canonical bases.
