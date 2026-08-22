# Session Handoff: Floor 1 odd AI behavior (issue #3275)

## Date

2026-08-22

## Persona

`Game AI Engineer`

## Systems touched

ai-behavior-tree, boss-rooms, quests

## Apples

4🍎 estimated, 4🍎 actual (ledger:
`docs/knowledge/review-ledgers/2026-08-22-floor1-odd-ai-behavior.review-ledger.json`)

## What Was Done

Issue #3275 reported five separate Floor 1 problems observed on seed 42 with the
`experienced_player` persona. Each was diagnosed against headless-runner
telemetry before any code was written.

**Baseline (seed 42, `npx tsx src/game/ai/headless-runner-cli.ts --seed 42
--persona experienced_player`):** VICTORY at 470.9s of a 600s budget, 130 kills,
level 9, score 171, **454 gold (43.1%) unspent**, **9 vendor visits**.

1. **Merchant round-trips.** Telemetry showed the smoking gun: at 148.4s the AI
   bought a **350g optional** Spell Broker spell, leaving 32g; 0.4s later it
   reached the merchant needing the **60g required** shopkeeper charm, recorded
   `unaffordable`, farmed, and walked the same route back at 202.9s. An optional
   purchase was pricing out a required one mid-errand. Fix: new
   `src/game/ai/required-purchase-reserve.ts`. `requiredShopPurchaseReserve()`
   holds back the charm price for every shop stage in which the charm is still
   unpaid (`not-met`, `awaiting-prize`, `ready-to-buy` — `not-met` matters
   because the broker unlocks the instant the Slime Rat dies, which can land
   while the errand is mid-fetch). It is added to the spell-purchase reserve in
   `auto-progression.ts` **and** netted out of the broker intent's own
   affordability view (`spendableGold()` in `spell-broker-intent.ts`), so the
   intent stays `farming` instead of oscillating to `returning` for a purchase
   the executor would refuse to fund.
2. **En-route farming while the clock is quiet.** The collapse-panic profile
   already scaled the opportunistic loot/enemy pulls _down_ toward the deadline;
   the opposite half was missing, which is why the run read as a speed-runner on
   the way _to_ its objectives. New `calmFarmPullBoost` knob, applied via the
   pure `resolveCalmFarmPullBoost()` only while `panic === 0` and no exit
   beeline is active, so it is structurally incapable of eating the exit margin.
3. **+ item 4. Post-boss farm window.** New `postBossFarmReserveFraction` AIConfig
   knob and the pure `resolvePostBossFarmWindow()` module, surfaced as the
   optional `AIInputProvider.isFarmingPostBossFloorTime()`. Once the staircase is
   unlocked but not yet taken, the BT Progress objective returns `null` (so the
   normal Engage → Collect → Explore ladder farms) and
   `autoFloor1ProgressionSystem` defers the descend confirm, until only the
   reserve fraction of the floor budget remains.
4. **Boss chest at the death spot.** `FloorBossEncounterState.lastKnownPos` is
   sampled every tick while a boss lives; both Floor 1 defeat branches drop the
   chest there via `resolveBossDeathChestPos()`, falling back to the authored
   room anchor when there is no sample or the sample resolves outside the boss's
   own room. Per-tick sampling is required because the Slime Rat branch runs
   after death cleanup has zeroed the typed-array component stores, so reading
   the dead eid returns `(0, 0)`, not `undefined`.
5. **Cleared arena becomes a safe room.** There was no boss-room → safe-room
   conversion at all; boss defeat only opened/unlocked doors. Added
   `world.clearedSafeRoomIds`, honored by `isPointInSafeSpace`, and populated by
   `markBossRoomCleared()` at both defeat branches. `resolveNearestSafeAnchor`
   honors it too, so retreat/equip routing uses the arena next door instead of
   walking back across the floor. The ids are stamped with the owning
   `FloorMap` (`clearedSafeRoomMap`) because room ids are unique only _within_
   one generated floor — without that scoping a cleared Floor 1 room id made
   the same-numbered Floor 2 room safe (caught in code review, reproduced on
   seed 10).

**Observed in the real pipeline (rule #9), headless AI runner, seed 42, at the
gate's 39600-frame budget — before: victory 470.9s, level 9, score 171, 9 vendor
visits with an `unaffordable` merchant bounce; after: victory 540.8s, level 13,
score 339, 7 vendor visits, zero `unaffordable`.** The blocking 25-seed /
100%-win-rate gate `tests/headless/floor1-completion.test.ts` still passes.

## Key Decisions Made

- **Reserve from `not-met`, not just `ready-to-buy`.** Reserving only at
  point-of-sale is provably insufficient: the first attempt (gated on
  `ready-to-buy`) produced **zero** change on seed 42, because the broker
  purchase fires while the errand is still `awaiting-prize`.
- **The reserve must also feed the intent, not only the executor.** Refusing the
  purchase at the till alone leaves `updateSpellBrokerIntent` in `returning`,
  which walks the AI back to the broker every tick. Netting the reserve into the
  deficit is what actually removes the round trip.
- **Register cleared room _ids_; do not rewrite `RoomRole` to `SAFE`.**
  `FloorMap.bossStairRoom` / `safeRoom` / `spawnRoom` are role-derived getters
  (`getFirstRoomByRole`), so a role rewrite would make the boss room vanish from
  under its own staircase and break `isFullyInsideBossRoom`, the minimap and
  spawn suppression. `pickSpawnRoom` already excludes SAFE/BOSS_STAIR rooms, so
  no spawn change was needed.
- **New knob only; `DEFAULT_CONFIG` values untouched.** `experienced_player` _is_
  the production baseline (`PRODUCTION_TUNING_DEFAULTS` derives from
  `DEFAULT_CONFIG`), which is a promoted AI-Sweep winner carrying an explicit "do
  NOT weaken these values" comment. Items 2 and 4 were delivered by _adding_
  `postBossFarmReserveFraction`, never by retuning an existing knob.
- **The calm boost is cliff-edged at `panic === 0`, not a smooth ramp.** A
  smooth "more time → more farming" curve would interact with the panic ramp in
  both directions and could trade exit safety for loot at the margin. Gating on
  "the clock is not applying any pressure at all" makes the safety argument
  trivial: the boost and the panic ramp are never active at the same time.
- **The planner reserves the charm too, not just the executor.** `buildFloor1GoalGraph`
  now nets the reserve out of the optional-purchase deficits
  (`optionalPurchaseGold`), so it cannot route the AI to a vendor the purchase
  code will refuse to fund — the same round-trip class of bug one layer up.
- **Anchor fallback for an out-of-room death spot.** A chest outside the arena
  could be unreachable, and a stranded reward is strictly worse than a centred
  one.

## What's Next / Blockers

- The cleared arena pauses the collapse timer while the player stands in it
  (`floorObjectiveSystem` advances `objective.deadlineMs` while
  `world.playerInSafeRoom`). That is intentional per the GDD's "Boss →
  Commercial Break" loop, but it means a CLI run with the default
  `--max-frames 100000` reports a longer game time than the 39600-frame gate
  budget. Always validate Floor 1 AI changes with `--max-frames 39600`.
- Only Floor 1 arenas convert today. Floor 2+ boss rooms are a natural follow-up
  and would reuse `markBossRoomCleared` unchanged.
- `postBossFarmReserveFraction` (0.2) and `calmFarmPullBoost` (1.35) were set by
  reasoning plus a seed-42 measurement and the 25-seed gate, not by an AI Sweep.
  A sweep over both axes (and over the `min_max_cheeser`/`explorer` values) is
  the obvious way to turn them into measured winners.

## Retrospective

### Lessons Learned

- **Telemetry first pays for itself.** The merchant bug looked like a pathing or
  memory problem in the issue text; the event log showed it was a purchase
  ordering problem, and the fix landed in a 30-line module instead of the AI's
  navigation.
- **Frame budget is part of the experiment.** The headless CLI defaults to
  `--max-frames 100000` while the gate uses `FLOOR1_DEFAULT_MAX_FRAMES` (39600).
  A farm-window change measured at the CLI default looks far better than it is,
  because `resolveFloor1PlanningDeadlineMs` clamps to the runner deadline.
- **Death cleanup zeroes stores, it does not undefine them.** Reading a dead
  eid's `Position` silently yields `(0, 0)`; any "where did it die" feature needs
  a live sample.

### Mistakes Made

- Gated the first version of the reserve on shop stage `ready-to-buy` only and
  re-ran seed 42 expecting a win — the run was byte-identical. **Early signal:**
  the purchase timestamp (148.4s) was _before_ the stage ever reached
  `ready-to-buy`; comparing the two timestamps in the baseline log would have
  caught it before the code was written.
- Fixed the executor before the intent, which left the AI still walking back to
  the broker. Reserve-style fixes need to touch **both** the point-of-sale and
  the desire that drives navigation.
- Wrote the boss-chest test with a full-tile offset from the anchor, which landed
  outside the room and silently exercised the fallback path instead of the new
  one. **Early signal:** the assertion failed with the _anchor_ value, which is
  precisely what "fallback taken" looks like.

### Opportunities for Future Improvement

- A generic "reserve" registry would be better than N ad-hoc reserve functions
  (`_spellPurchaseReserve`, `merchantWeaponReserve`,
  `requiredShopPurchaseReserve`); every new optional purchase currently has to
  remember to consult every required one.
- `isPointInSafeSpace` now does a room lookup per call. It is cheap, but a
  cached "safe tile" set rebuilt on `clearedSafeRoomIds` mutation would be
  strictly better if safe-space checks ever move into a hot loop.
- Worth a deterministic check that no optional purchase can ever drop spendable
  gold below the sum of outstanding required purchases — that is the invariant
  behind item 1, and it is currently protected only by targeted tests.
