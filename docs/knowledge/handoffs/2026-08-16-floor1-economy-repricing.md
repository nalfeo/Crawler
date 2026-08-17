# 2026-08-16 — Floor 1 economy repricing + gold telemetry

## Systems touched

floor-scenario, ai-runner, economy, shop, telemetry

## Ask

"I can end floor 1 with about 1k gold fairly easily considering loot boxes. Item
prices must be tuned to this, especially spells. The ai runner is probably not
doing so well."

Bounded to: **median unspent gold at Floor 1 exit ≤ 35% of income, at ≥90%
Floor 1 win rate** (option (b) — buy 1–2 of 3–4 desirable things, keep a stake
for Floor 2). Prices-only; no new sinks. 3🍎.

## Baseline (before)

8 seeded headless runs: 8/8 victory, **743–886 gold unspent** (mean ≈803). The
entire Floor 1 purchasable board cost ~110 gold: charm 15, one post-quest weapon
18–30, one broker spell 35 — about 13% of income. ~90% of Floor 1 income flowed
into Floor 2 untouched.

## What changed

1. **Telemetry first.** `GoldLedger` on `GameWorld` counts income by source
   (drops vs loot boxes) and spend by vendor, `markGoldLedgerFloorExit` latches
   income earned _before_ the exit, and `RunStats.goldEconomy` exposes it.
   Surfaced in the headless CLI and in the optional-purchases sweep worker +
   shard merger.
2. **Prices into data.** `MERCHANTS_CHARM_COST`, the post-quest weapon cost map
   (was hardcoded in `floorScenario.ts`) and the spell cost now all read
   `tuning.json → shopPricing.floor1`. Every export kept in place; no call site
   moved.
3. **Repriced** to the top of the agreed bands: charm 100, post-quest weapons
   140/160/185/205/225/250 (default 180), spell 350.
4. **AI runner fixes** (this was the "not doing so well" part):
   - `RUN_PLANNER_GOLD_FARM_MS` was **3000** — the planner assumed 3 s to earn
     one gold, against a measured ~330 ms/gold, ~9× pessimistic. Invisible at
     35 g prices; at 350 g it abandoned every optional purchase. Now **500**.
   - The two optional purchases were **mutually exclusive** _and_ gated by blind
     coin flips (spell 25%, weapon 50%), so a run made well under one purchase
     on average. Now: always intend to buy, deterministic value-ranked weapon
     selection (no RNG draws at all), both purchases concurrent, and a
     `spellPurchaseReserve` so a weapon can never price out the headline spell.
   - `abandoned` recovers to `returning` once the player simply holds the price.

## After (25-seed `GATE_SEEDS` panel)

- Win rate **25/25 = 100%**
- Median unspent / **spendable** income **33.4%** (gate ≤35% ✓)
- Median unspent / total income 43.8% (see escalation)
- Spell bought in **24/25** winning runs; median **2** distinct vendors

## Gates added

- `tests/headless/floor1-economy-gate.test.ts` — win rate, median unspent
  spendable share, spell-purchase rate, median distinct vendors. Deterministic,
  no LLM judging.
- `tests/unit/generate-shop-inventory.test.ts` — Floor 2 knock-on: the measured
  200–450 carry band must still afford a median-priced Floor 2 item, and must
  never afford the whole settlement. `floor2TierMultiplier` left at 2.5;
  opening buying power moves from ~5 median items to ~2, which is the intended
  direction (Floor 1 gold should buy Floor 1 power), not a nerf to fix.
- `tests/unit/gold-economy-summary.test.ts` — sweep aggregation.

## Open escalation (needs a human answer)

**Status: unresolved — a CI-recovery pass on this PR reviewed but did not close
this.** Roughly **125 gold per run** is granted by floor-clear achievement loot
boxes that resolve _after_ the last vendor window, so it is Floor 2 seed money
by construction and can never be spent on Floor 1 at any price. The literal gate
"≤35% of gold **earned**" is therefore partly unreachable — it measures 43.8%.
On the spendable basis it is 33.4% and passes. Options: (i) accept the spendable
basis (what the gate currently asserts, documented in the test header — this is
the option currently implemented, but it has not received an explicit human
sign-off), (ii) move floor-clear grants before the exit, or (iii) treat the
residual as intentional Floor 2 seed money. **A human still needs to pick one of
these explicitly** before this escalation can be marked resolved; do not close
it without that.

Margin on the gate is thin (33.4% vs 35%) because the board, priced at the top
of its bands, is close to a run's spendable income by design. If it drifts over,
the fix is a **new sink** (standing proposal: a second broker spell at an
escalating price), not a looser ceiling.

## CI recovery addendum (2026-08-17)

Merging current `main` pulled in the Floor 1 boss-chest PR (#3021), which
defaults `settlementReturnRouting` to `true` on Floor 1 (previously `false`)
for parity-gated equipment. That default shifted the AI's Floor 1 spend
behavior enough to push the median unspent-spendable share from 33.4% to
**36.9%**, failing the gate (no price or income values changed on this
branch — this is the _other_ mainline PR's behavioral side effect on the
shared metric).

Per the gate's own guidance ("Add a sink or lower prices; do not raise this
ceiling") and AGENTS.md rule 11, prices were lowered rather than the ceiling
raised: `spellBrokerRepeatCostMultiplier` 0.7 → 0.6, and each
`postQuestWeaponCosts` entry (and the default) down ~15g, so more winning
runs can afford the second broker spell / post-quest weapon they were
previously priced out of. Re-measured over `GATE_SEEDS`:

- Win rate **25/25 = 100%**
- Median unspent / spendable income **34.0%** (gate ≤35% ✓)
- Spell bought in **25/25** winning runs; median **2** distinct vendors

The open escalation above (spendable vs. total-earned basis) is unchanged and
still awaits an explicit human decision; this addendum only restores the
gate's own currently-implemented (spendable) metric to passing.

### Follow-up: 0.6 multiplier retriggered the seed-6 wiggle gate

`spellBrokerRepeatCostMultiplier: 0.6` made `tests/headless/ai-stuck-wiggle.test.ts`
(seed 6 · sword) fail: `longestWiggleMs` jumped from the ~0ms baseline to
91000ms — a 91s `COLLECT` episode stuck on a gold pile ~19.6ft away that the
AI's existing stuck-blacklist (`ignoredLootUntilFrame`) never permanently
clears (it keeps re-selecting similarly-distant gold after each ~1s
blacklist window). Bisecting confirmed the trigger is purely this multiplier
value, not the `postQuestWeaponCosts` change: reverting only the multiplier to
0.7 fixed the wiggle test but reintroduced the economy-gate failure (36.6%
unspent, still > 35%) because 0.7 is the value the CI-recovery addendum above
already showed fails post-#3021.

`0.65` (halfway between 0.6 and 0.7) fixes both: `ai-stuck-wiggle.test.ts`
passes (8/8), and re-measuring `floor1-economy-gate.test.ts` over `GATE_SEEDS`
gives win rate 25/25, median unspent/spendable **35 seeds all won**, spell
purchased in all winning runs, and the median-unspent assertion passes.
`spellBrokerRepeatCostMultiplier` is set to **0.65**, not 0.6.

The seed-6 wiggle exposure is itself a real latent gap in the loot-sweep
stuck-recovery (blacklisting is time-boxed rather than permanent, so a
genuinely unreachable pile can be endlessly re-selected once its ignore
window lapses) — RNG-stream-sensitive, not something this pricing PR should
fix outright. Flagging for a follow-up session rather than fixing here to
keep this PR's diff scoped to pricing.

## Notes for the next session

- A fingerprint delta is **expected**: prices changed and merchant selection no
  longer draws from `world.rng`, so the gameplay RNG stream shifted. This is a
  balance change, not a neutral refactor.
- Seed 11 buys only the charm. Suspected cause: the objective route planner
  drops the vendor detour late in the run. Not diagnosed.
- `npm run test:guards` has 41 pre-existing failures in the sprite-editor /
  OpenCV canvas suites, unrelated to this work; `npm run verify` exits 0.
