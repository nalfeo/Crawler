# 2026-09-06 — Floor 1 spell-broker rack cap

## Systems touched

src/game/floorScenario.ts, tests/game/spell-broker-progression.test.ts

## Ask

Issue #4284: it must not be possible to buy all three Floor 1 Spell Broker
spells, so the first broker decision stays an economic choice instead of a free
three-spell bundle funded by achievement loot boxes.

## What changed

- Enforced the canonical per-run rack cap (`FLOOR1_SPELL_BROKER_MAX_PURCHASES`,
  2, below `FLOOR1_SPELL_BROKER_OFFER_COUNT`, 3) inside
  `isSpellBrokerSpellEligibleIgnoringGold`, the shared eligibility gate every
  purchase path funnels through. The cap previously lived only in the AI's
  broker intent (`src/game/ai/spell-broker-intent.ts`), so a human player with
  enough banked gold could still clear the whole rack.
- The count is read from the durable `offer.purchased` flags on
  `world.floorScenario.spellBrokerOffers`, so headless runs and human players
  see the identical bound.

## Why not reprice achievement gold

The first attempt lowered `LOOT_BOX_GOLD_BY_TIER`. That is the wrong lever: the
Floor 1 catalog has 103 achievements, so the _maximum_ obtainable pre-broker
payout is thousands of gold at any sane per-tier value — repricing can never
make the sum-based bound hold. It also regressed the headless Floor 1 economy
gate (median unspent share rose to 38.0% against the 35% ceiling) because a
poorer run simply banks gold it can no longer spend. The purchase cap makes the
invariant structural and gold-independent, and leaves the measured economy
untouched.

## Evidence

- `tests/game/spell-broker-progression.test.ts` — new case gives the run 10x the
  full rack cost and asserts exactly `FLOOR1_SPELL_BROKER_MAX_PURCHASES`
  purchases succeed, at least one offer stays unbuyable, and the gold ledger
  records no extra spend. It also pins
  `FLOOR1_SPELL_BROKER_MAX_PURCHASES < FLOOR1_SPELL_BROKER_OFFER_COUNT` from
  canonical data.
- AI behavior is unchanged: `markSpellBrokerPurchased` already went terminal at
  the same cap, so no headless run ever attempted a third purchase.
