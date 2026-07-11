# Floor 1 Merchant Starter Stock

**Persona:** Game Designer

## Systems touched

quests, weapons

## Summary

Sweaty Merchant post-quest weapon stock on Floor 1 now draws only from the
canonical opening loadout set (`sword`, `bow`, `baseball-bat`) instead of the
broader Floor 1 manifest starter list. This prevents off-list offers such as
Rusty Shiv / Flare Gun when the floor's visible starter set is the normal
three-weapon loadout.

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

Direct runtime probe in an initialized Floor 1 world (seed 5) with
`starterChoices` forced to `['sword', 'bow', 'baseball-bat']` returned:

- `bone-club`
- `iron-sword`

No off-list offers such as `rusty-shiv` or `crystal-wand` appeared.

## Review harness / ledger

- Ledger: `docs/knowledge/review-ledgers/2026-07-11-floor1-merchant-starter-stock.review-ledger.json`
- Tier: 2 apples (no review stages required)

## Validation

- `npx vitest run tests/game/floor1-scenario.test.ts -t "offers 2 deterministic extra starter-weapon options from the Floor 1 loadout set"`
- `npx tsx --eval "... getShopkeeperPostQuestStock(world) ..."` (direct runtime probe)
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-11-floor1-merchant-starter-stock.review-ledger.json`
- `npm run verify:pr-prereqs`

## Apples

Estimated: 2 apples. Actual: 2 apples. Exact: a small shared-constant fix plus
one focused merchant regression.
