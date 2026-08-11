# Floor 1 Merchant Starter Stock

**Persona:** Game Designer

## Systems touched

quests, weapons

## Summary

Sweaty Merchant post-quest weapon stock on Floor 1 now draws only from the
canonical opening loadout set (`sword`, `bow`, `baseball-bat`) instead of the
broader Floor 1 manifest starter list. It also excludes the player’s selected
starter from the post-quest reroll, so a normal three-weapon opening now offers
only the other two canonical weapons instead of off-list items or a duplicate of
the chosen starter.

## Changes

- Exported `FLOOR1_LOADOUT_CHOICE_IDS` from
  `src/game/scenarios/floorLoadoutScenario.ts` so the opening loadout set has a
  single source of truth.
- Updated `getShopkeeperPostQuestStock()` to build its candidate pool from that
  canonical loadout set.
- Tightened the Floor 1 merchant regression test to simulate the reported
  sword/bow/baseball-bat starter list and assert the merchant only offers items
  mapped from that set.

## Runtime observation

Real headless pipeline observation (`runHeadless`, seed 22, forced starter
selection `sword`) naturally produced the visible starter trio
`['sword', 'bow', 'baseball-bat']` and completed the merchant quest in both
runs:

- Before this fix (same headless seed on commit `5908ca8`): post-quest stock was
  `fireball`, `throwing-knife`.
- After this fix (same headless seed on the repaired branch): post-quest stock is
  `bone-club`, `frost-bow`.

That replaces the off-list post-quest candidates with the other two canonical
starter items and keeps the selected `sword` from reappearing for sale.

## Review harness / ledger

- Ledger: `docs/knowledge/review-ledgers/2026-07-11-floor1-merchant-starter-stock.review-ledger.json`
- Tier: 2 apples (no review stages required)

## Validation

- `npx vitest run tests/game/floor1-scenario.test.ts -t "offers the other 2 canonical starter-weapon options after the Floor 1 quest completes"`
- `npx tsx /tmp/observe_merchant_headless.ts 22 sword` on commit `5908ca8` and again on the repaired branch (real `runHeadless` pipeline observation)
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-11-floor1-merchant-starter-stock.review-ledger.json`
- `npm run verify:pr-prereqs`

## Apples

Estimated: 2 apples. Actual: 2 apples. Exact: a small shared-constant fix plus
one focused merchant regression.
