# Session Handoff: Floor 1 Gear unlock must wait for the merchant charm

## Date

2026-08-22

## Persona

Game Designer

## Systems touched

quests

## Apples

2🍎 estimated, 2🍎 actual (exact).

## What Was Done

- `latchFeatureUnlocks` (`src/core/systems/questSystem.ts`) now applies the Floor 1
  merchant-charm gate for the **whole floor** instead of only once
  `FLOOR1_SHOP_QUEST_ID` is already in the quest log, so `featureUnlocks.equipment`
  latches only from the merchant charm (issue #3310).
- Added a real-scenario regression test (`tests/game/floor1-scenario.test.ts`): after
  `initializeFloor1Scenario` + `selectFloor1StarterWeapon`, one `questSystem` +
  `achievementSystem` tick must leave Gear **and** the `merchant-customer`
  ("Buy your first piece of gear") achievement locked; buying the charm unlocks both.
  The test fails on the pre-fix code.

**Runtime observation (rule #9) — real headless pipeline, `runHeadless` seed 44 / sword,
not a lab:**

- Before: `featureUnlocks.equipment` latched at **frame 1** with an _empty_ bag —
  `selectFloor1StarterWeapon` equips the starter into `mainHand`, and the old gate was
  inactive because the shop quest was not in the log yet. Downstream, the
  `merchant-customer` achievement ("Buy your first piece of gear") unlocked at
  **frame 1** and paid out its loot box without the player buying anything.
- After: Gear stays locked until the charm purchase — `merchant-customer` unlocks at
  **frame 10099**, the frame the charm is bought.

## Key Decisions Made

- The gate is floor-scoped, not quest-log-scoped: quest-acceptance timing must not be
  able to open Gear, because the starter weapon is equipped from frame one on every
  Floor 1 run (real game and headless alike, via
  `src/game/scenarios/starterWeaponEquip.ts`).
- Not weakened to keep a seed green (rules #11/#12) — see blockers.

## What's Next / Blockers

**Escalation — `Headless Floor 1 Gate` seed 44 / sword needs a human balance call.**
`tests/headless/floor1-legacy-death-regressions.test.ts` → "sword seed 44 enters ready…"
now fails on one assertion: staircase entry health `0.461` vs the `0.5` readiness bar
(12 of 13 cases in that file still pass; the run still ends in an official victory).

Measured cause, not seed luck in the fix itself: pre-fix the run collected the
`merchant-customer` loot box at frame 1, so it had merchant gold early and bought a
350g broker spell (`spellPurchases: 1`, `unspentAtExit: 261`). Post-fix that reward
arrives only after the charm purchase, so the same run reaches the broker without the
gold (`spellPurchases: 0`, `unspentAtExit: 685`, `unspentSpendableFraction: 0.78`) and
enters the staircase weaker.

**Second-pass evidence (2026-08-23): the drop is one seed's trajectory, not a floor-wide
readiness regression.** A/B over the same 10 sword seeds (`runHeadless`, legacy
pathing/decision modes, 19,800-frame budget), pre-fix vs post-fix staircase entry health:

| Seed | Pre-fix |  Post-fix | Pre spendable / spells | Post spendable / spells |
| ---: | ------: | --------: | ---------------------: | ----------------------: |
|    2 |   0.815 |     1.000 |                821 / 1 |                 588 / 1 |
|    6 |   0.581 |     0.620 |                600 / 2 |                 781 / 2 |
|   25 |   0.724 |     0.724 |                238 / 0 |                 238 / 0 |
|   29 |   1.000 |     0.852 |                846 / 2 |                 439 / 1 |
|   34 |   1.000 |     0.992 |                423 / 1 |                 261 / 0 |
|   35 |   0.633 |     0.695 |                766 / 2 |                 424 / 0 |
|   44 |   0.695 | **0.461** |                446 / 1 |                 270 / 0 |
|   67 |   0.902 |     1.000 |                431 / 1 |                 588 / 2 |
|   81 |   0.959 |     1.000 |                628 / 1 |                 265 / 0 |
|   84 |   0.756 |     0.698 |                612 / 1 |                 590 / 2 |

10/10 official victories both before and after; 9/10 post-fix seeds still enter the
staircase at or above the `0.5` readiness bar. The systematic part of the change is
income timing (median spendable income falls ~29% on this panel, broker-spell
purchases 12 → 8),
which the official `floor1-economy-gate.test.ts` still passes; seed 44 is the only
readiness casualty. Seed 25 is byte-identical pre/post, confirming the divergence is
reward-timing driven rather than a blanket nerf.

Also relevant to option 1: when `sword seed 44` was originally accepted into this panel
(`docs/knowledge/handoffs/2026-07-16-legacy-floor1-deaths.md`) the accepted run's
**minimum HP was 35.0%**. This run's post-fix minimum is 34.4% — i.e. the case is
behaving as it did when it was adopted; the `0.5` boss-entry bar was added later, under
the (buggy) inflated economy.

Every remaining path to green either weakens the maintainer's explicit requirement in
issue #3310 or relaxes/cherry-picks the readiness gate, both of which rules #11/#12
forbid without a human decision. Options for the human:

1. Re-baseline the readiness expectation for the legacy seed panel (accept that the
   free frame-1 loot box was the thing propping seed 44 up).
2. Rebalance the Floor 1 economy so the gold that the unearned achievement used to
   provide arrives earlier by legitimate means.
3. Teach the Floor 1 AI to convert late gold into power (it now ends the floor holding
   78% of its spendable income).

Recommendation: option 1, scoped to a re-derivation of the `sword seed 44` entry
expectation with this A/B recorded next to it — _not_ a lower global
`BOSS_ENTRY_MIN_HEALTH_FRACTION` and _not_ dropping the seed from the panel. That still
needs an explicit human "yes", because any of the three edits touches a gate this
session does not own (rule #11).

## Retrospective

### Lessons Learned

- `featureUnlocks.equipment` is not a UI-only flag: it feeds `equipGeneratedFromBag`
  (ADR 0087) **and** the `equipmentUnlocked` achievement fact. Changing when it latches
  changes Floor 1 reward/economy timing, which re-rolls whole headless runs.
- A "gear unlock" bug on Floor 1 is usually about the starter weapon, not loot: the
  starter routes through `equip()`, so `equipmentState.equipped.mainHand` is non-null
  from frame one on every run.
- Probing the real headless pipeline (temporary `console.log` in `unlockAchievement`,
  reverted) was the fastest way to prove the before/after and to attribute the CI
  readiness drop to reward timing rather than to lost gear.

### Mistakes Made

- The first pass shipped only unit-level tests and no real-artifact observation, which
  the PR reviewer correctly rejected under rule #9. The early signal was that the change
  touches a latched world flag consumed by the sim — anything in that class needs a
  headless before/after, not just a `questSystem` unit assertion.
- Initial `git stash` attempt to get a baseline was a no-op because the change was
  already committed; `git checkout HEAD~1 -- <file>` is the reliable A/B swap.

### Opportunities for Future Improvement

- The `merchant-customer` achievement being satisfiable by "any equipment unlock" rather
  than an actual purchase event is still a proxy; a real `gearPurchased` fact would be
  tamper-proof.
- The Floor 1 legacy readiness panel has no attribution output — when a seed dips, the
  gate could print the gold/spell/gear deltas so the next agent doesn't have to
  hand-instrument the runner.
