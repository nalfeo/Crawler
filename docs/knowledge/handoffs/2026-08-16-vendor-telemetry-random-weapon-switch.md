# 2026-08-16 — Vendor run-stats telemetry + randomized merchant weapon switch

## Systems touched

floor-scenario, ai-runner, economy, shop, telemetry

## Ask

> "Run stats needs to include vendor inventory, all merchant visits + decisions
> made (ie wanted to purchase and did or didn't because couldn't afford).
>
> Weapon purchase and switching from the merchant needs to be random, not an all
> the time thing — it's supposed to represent the player making a very
> meaningful change to switch play styles."

## What changed

1. **Vendor ledger (`core/world.ts`).** `world.vendorLedger` records every
   vendor **visit** (vendor id, game time, frame, gold held, and the full stock
   on offer with prices) and every shopping **decision**
   (`wanted | purchased | unaffordable | declined | abandoned`, with the item,
   cost, gold held, and a machine-stable reason tag). Same-frame re-entry
   collapses into one visit; consecutive identical decisions collapse so a
   re-polled pending intent is not counted repeatedly. Both lists cap at 64
   retained entries and count the overflow, so `RunStats` stays small.
2. **Recording sites (`game/floorScenario.ts`, `game/ai/merchant-weapon-intent.ts`).**
   Floor 1 merchant and Spell Broker: `meetShopkeeper`, `meetSpellQuestGiver`,
   the charm purchase, the post-quest weapon purchase and the broker spell
   purchase, plus the AI's weapon intent (declined / wanted / abandoned /
   unaffordable). The "wanted it, couldn't pay" case is recorded explicitly on
   both the charm and the weapon/spell paths.
3. **`RunStats.vendors`** (`VendorInteractionSummary`): retained visits and
   decisions, total counts (including dropped overflow), visits per vendor and
   decision-outcome counts. Populated by both `runHeadless` and
   `collectHumanRunStats`, and printed by the headless CLI under
   "🛒 Vendor Visits & Decisions".
4. **Weapon-class switch is now a per-run roll.** `updateMerchantWeaponIntent`
   previously always intended to buy. It now first rolls
   `rollsMerchantWeaponSwitch(world.seed)` at
   `MERCHANT_WEAPON_SWITCH_CHANCE = 0.75`; a run that does not roll it goes
   straight to `declined` and keeps its starter for the whole run. The roll uses
   its own `hashStringToSeed` stream, so it consumes **no** gameplay RNG, and it
   discards its first draw (xorshift32's opening output correlates with the
   seed: the contiguous 1..25 gate panel read 24% instead of ~50% without the
   discard).

## Evidence (25-seed `GATE_SEEDS` panel, headless)

| policy                     | weapon buys | median unspent-spendable | gate ≤35% |
| -------------------------- | ----------- | ------------------------ | --------- |
| always willing (previous)  | 8/25        | 33.4%                    | ✓         |
| **0.75 willingness (new)** | **7/25**    | **33.3%**                | **✓**     |
| 0.5 willingness            | 4/25        | 37.2%                    | ✗         |

`tests/headless/floor1-economy-gate.test.ts` passes at 0.75 (25/25 wins, spell
bought in the large majority, median 2 distinct vendors). Observed in the real
artifact: `npm run ai:headless -- --seed 1` prints the vendor visit/decision
block, including `declined nothing (0g, ..., no-weapon-class-switch-this-run)`.

## Open escalation (needs a human answer)

**A rarer switch needs a new gold sink first.** Floor 1's entire purchasable
board already sits at the top of its designer-agreed price bands (charm ≤100,
weapons 120–250 with ≥80 spread, spell ≤350 — pinned by
`tests/game/spell-broker-progression.test.ts`), so there is no pricing headroom
to absorb the gold a declining run keeps. 0.75 is therefore the lowest
willingness the current board supports; below it the economy gate's 35% ceiling
breaks. Raising the charm to 175 does make 0.5 pass, but it violates the agreed
band and inverts the charm-below-weapons ordering, so it was reverted. If the
designer wants a genuinely rare switch (say 0.25–0.5), pair it with the standing
sink proposal (a second broker spell at an escalating price) rather than a
looser economy ceiling.

## Notes for the next session

- A sim-fingerprint delta is **expected**: declining runs farm and shop
  differently. The RNG _stream_ is untouched (the roll has its own stream), but
  behavior changes, so this is a balance change, not a neutral refactor.
- `tests/game/merchant-weapon-purchase.test.ts` no longer hardcodes seed 1: it
  derives a willing seed and a declining seed from `rollsMerchantWeaponSwitch`,
  so retuning the chance does not silently invalidate the suite.
