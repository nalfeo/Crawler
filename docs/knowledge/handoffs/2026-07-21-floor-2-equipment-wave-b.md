# Floor 2 equipment content wave B

**Date:** 2026-07-21
**Branch:** `nalfeo-floor-2-equipment-wave-b-shepherd`
**Apple estimate:** 4🍎
**Actual complexity:** 4🍎

## Systems touched

inventory, weapons, ci-policy

## What was done

- Added the locked roster of exactly 25 generated weapon bases beginning
  `weapon.venom-dirk`, `weapon.moon-scythe`, and `weapon.tower-spear` as the
  deterministic complement of merged Wave A squash `8370b1a666046c0897dfa5bfdb3344fce4eb2087`.
- Added exactly 20 generated armor, accessory, and off-hand bases. Together with
  the weapons, Wave B is a 45-base overlay across the canonical manifest rather
  than a contiguous ordinal 26-70 partition.
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

- Focused Wave B, Wave A, and equipment ECS: 3 files and 66 tests passed.
- Wave A production pipeline: 1 test passed.
- `npm run equipment:balance-gate`: all 4 deterministic DPS and distribution
  gates passed, including the constitutional 1.7x-2.3x median envelope.
- `npm run verify:fast`: passed on the final code diff.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-20-floor-2-equipment-wave-b.review-ledger.json`:
  passed for the refreshed tier-4 review cycle.
- `npm run verify:pr-prereqs`: passed.

## Review

- Adversarial plan review by `gpt-5.4` retained the preserved-chain recovery
  with minor divergence. All 8 concerns were resolved through explicit squash
  ancestry and prohibited-path audits, Wave-B-only name overrides, direct
  Quartermaster name-uniqueness coverage, 20-field shared-default and override
  checks, truthful coordination refresh, post-fix validation, and a code-PR-only
  publication boundary. The final design remains the locked 25-weapon plus
  20-non-weapon 45-base overlay rather than a contiguous 26-70 partition.
- The original code and multi-model rounds resolved the equipment-lab catalog
  boundary plus stale coordination wording.
- Fresh post-rebase code review by `claude-sonnet-4.6` found one stale handoff
  statement; the delegated correction was followed by a clean confirmation
  round across every review category.
- Fresh multi-model review used `gpt-5.3-codex` and
  `gemini-3.1-pro-preview`, with `gpt-5.4` adjudication. The only reported
  concern was rejected as a speculative weapon-name expansion outside the
  explicit Quartermaster non-weapon uniqueness contract, leaving zero valid
  concerns.

## Coordination

The preserved authoritative Wave B ref
`451ebb7b3266f74b093ed5aec970461660a150c7` was rebased onto current main
`6162b732be934c736c702853c8b23d90f2b71aea`, which includes Wave A squash
`8370b1a666046c0897dfa5bfdb3344fce4eb2087` and generated-equipment carryover.
Wave A retains `weapon.thorn-whip`, `weapon.sawblade-launcher`, and
`weapon.oil-lantern`; Wave B remains disjoint, and the two 25-ID rosters form
the canonical 50-weapon union. The combined equipment catalog contains all 70
canonical bases while preserving current-main generator and carryover behavior.
