# Session Handoff: Shared Seed-69 Merchant Progression

## Date

2026-08-12

## Persona

Game AI Engineer

## Systems touched

quests, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual (exact).

## Problem

Authoritative release sweep run `31561657791` at SHA
`9eb2290273f526cfffb5da47fadde946b2bc6c78` recorded the same Floor 1
timeout for seed 69 across sword, bow, baseball-bat, pistol, throwing-knife,
and fireball. All six reached the 23,760-frame / 396-second budget with high
health and 195-274 kills, so the shared failure was progression rather than
combat.

Exact baseline reproduction showed the planner stalled on the merchant charm
step. The rat tail had been consumed and
`floor1-shop-prize-returned` had been set before the merchant quest existed.
After quest acceptance, `fetch-prize` could never latch because its item was
already gone.

## What Was Done

- Made `returnShopkeeperPrize` require an active Floor 1 merchant quest before
  it can consume the rat tail.
- Latched the `fetch-prize` objective atomically while the item is observably
  present, preserving same-interaction meet-and-return behavior in the visual
  game as well as the headless route.
- Added a six-weapon class regression that proves premature hand-in is rejected,
  then exercises acceptance, return, purchase, equip, and official quest
  completion.
- Changed no combat, weapon, health, damage, price, routing, or timing values.

## Real-Pipeline Evidence

Observed through the production `runHeadless` Floor 1 pipeline with seed 69 and
the authoritative 23,760-frame budget:

| Weapon         | Baseline | Fixed outcome | Frames | Time (s) | Kills |
| -------------- | -------- | ------------- | -----: | -------: | ----: |
| sword          | timeout  | victory       | 14,432 |   240.53 |    45 |
| bow            | timeout  | victory       | 13,349 |   222.48 |    60 |
| baseball-bat   | timeout  | victory       | 14,442 |   240.70 |    49 |
| pistol         | timeout  | victory       | 14,404 |   240.07 |    65 |
| throwing-knife | timeout  | victory       | 14,401 |   240.02 |    58 |
| fireball       | timeout  | victory       | 14,401 |   240.02 |    86 |

Two canonical reruns produced byte-identical `RunStats` fingerprints for every
weapon.

## Review

- Adversarial plan review corrected the initial timing hypothesis, identified
  the premature hand-in boundary, and rejected quest-system reordering, eager
  duplicate evaluation, stage masking, and purchase-only guards.
- The first multi-model review found one valid same-interaction visual-path
  concern. The implementation was changed from requiring a previously latched
  objective to latching atomically at the consumption boundary.
- Final exhaustive and multi-model reviews were clean after adjudication.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-08-12-seed-69-progression.review-ledger.json`.

## Validation

- Exact six-weapon seed-69 headless reruns: 6/6 official victories.
- Canonical deterministic fingerprint reruns: byte-identical for all six.
- Targeted changed tests: passed.
- `npm run verify:fast`: passed.
- `npm run check:wired-systems`: passed.

## Blockers

None.
