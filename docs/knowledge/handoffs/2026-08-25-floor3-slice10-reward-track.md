# Session Handoff: Floor 3 slice 10 — persistent player reward track wiring

## Date

2026-08-25

## Persona

Game Designer (systems-adjacent runtime wiring)

## Systems touched

enemies, inventory, quests

## Apples

2🍎 estimated, 2🍎 actual

## What Was Done

Wired Floor 3's defeated **rival** Companions (Trainer / Studio / Final Four
rosters) into the pre-existing persistent player reward track from spec R7,
closing issue #3535.

- New `src/game/floor3CompanionRewards.ts` —
  `awardFloor3CompanionDefeatRewards(world)` scans for rival Companions that are
  knocked out and not yet paid out, rolls `LOOT_TABLES.ELITE` unioned with the
  floor manifest's `floorLootTableId`, and spawns the drops through the existing
  `spawnXpGem` / `spawnGold` / `spawnDroppedItem` pickup helpers. Collection is
  entirely unchanged — `itemPickupSystem` already routes gems/gold/items into
  `world.playerLevel.xp`, `world.playerGold`, and `Inventory`.
- New `companion.defeatRewarded` store field latches the payout once per entity.
- Wired at the head of `floor3ObjectiveTick`.

Wild Floor 3 pets needed **no** change: they are plain `Enemy` entities, so
`dropSystem` was already paying `BASIC_MELEE` + `floor_3` for them. A regression
test now pins that half of the track too (a Floor 3 wild kill yields exactly
4 XP), so a future floor-table edit can't silently sever it.

Observed in the real artifact (rule #9), not a lab —
`tests/integration/floor3-reward-track-pipeline.test.ts` drives the canonical
`createFloorMainSceneOptions('floor3')` pre/post systems through
`runSimulationStep` (the same wiring the headless AI runner and the visual game
use):

- **before** (reward call removed): a rival dropped to 0 HP latched
  `knockedOut = 1` but `world.playerLevel.xp` stayed `0` and `defeatRewarded`
  stayed `0`;
- **after**: the same run pays out, with
  `world.lootLedger.xpCollected === world.playerLevel.xp`.

The wipe-frame case was verified the same way: with the wiring removed,
`floor3ObjectiveTick` despawns a defeated Studio roster having paid 0 pickups.

## Key Decisions Made

- **Reward at KO, not at roster despawn.** A rival Companion never reaches
  `Health.current === 0` for longer than one system boundary —
  `companionKOSystem` clamps it back to 1 — so KO _is_ Floor 3's death event.
  Paying at KO also means individual defeats read as progress during a long
  Studio fight rather than as a lump sum at the end.
- **One-shot latch on the entity, not a world-level `Set`.** The generic
  engagement-end revival (spec R11) can revive a KO'd rival, so an unlatched
  payout would be farmable by re-KO'ing the same Companion. Storing the latch as
  a typed-array store field makes it EID-recycling-safe for free, because
  `clearEntityStores` already zeroes every store slot on entity create/remove.
- **Hook point is the head of `floor3ObjectiveTick`, not a new
  `afterSpawnerSystems` entry.** `afterSpawnerSystems` is spliced into
  `preSystems`, i.e. _before_ the core step's `companionKOSystem`, so it would
  see a KO one frame late — and the KOs that complete an encounter are despawned
  by `despawnFloor3EncounterRoster` in that same frame, so the final payout of
  every Studio would be silently lost. The objective tick runs in `postSystems`,
  after the KO and immediately before the despawn.
- **No new balance numbers.** Rivals roll the existing `ELITE` type table
  because they are trained League combatants rather than ambient wildlife; slice
  16 owns the actual tuning against the win-rate sweep.
- **Player-party Companions are explicitly excluded** (`Team.id ===
TeamId.PLAYER`), so your own party going down can never pay you.

## What's Next / Blockers

- No blockers. Slice 16's balance pass should retune the rival payout (currently
  `ELITE` + `floor_3`) against a real Floor 3 win-rate sweep — the payout size
  is a first playable pass, not a balanced number.
- The headless AI runner does not yet seek Studio encounters on Floor 3 (a
  20k-frame run on seed 7 produced 3 wild kills and no rival engagement), so
  rate-based reward evidence has to wait for the Floor 3 AI/objective work. That
  is why the observe-before-done evidence here is a deterministic real-pipeline
  test rather than a sweep.
- Slice 11's `KeptCompanionContract` producer is the natural next consumer of
  this area; it touches the same `Companion` store.

## Retrospective

### Lessons Learned

- Floor 3 rivals are invisible to every death-driven system by design.
  `companionKOSystem`'s clamp-to-1 is deliberately documented as "so
  `dropSystem`'s `[Enemy, Health]` kill query never observes 0" — any future
  "reward/count/score on death" feature must treat `Companion.knockedOut` as the
  death signal on Floor 3, exactly as the KO system's own header warns.
- `world.floorScenario` is `null` on Floor 3, which is what makes `dropSystem`'s
  `allowFloorDrops` (`!world.floorScenario || floor1-drops-unlocked`) fall open
  there — Floor 1's onboarding drop gate does not accidentally suppress Floor 3
  wild drops. Worth knowing before "fixing" a drop gate.
- Mutating out the wiring line and re-running the tests is a cheap, exact way to
  produce the rule #9 before/after evidence for a non-visual runtime change,
  and it doubles as proof that the new tests are not vacuous.

### Mistakes Made

- Reached for a headless Floor 3 run first as observe-before-done evidence; it
  never engages a Studio roster, so it could not show the new behavior at all.
  The early signal was that Floor 3 has no AI objective wiring yet (noted in the
  2026-08-24 progression-wiring handoff) — read the recent handoffs for the
  floor before choosing the observation artifact.

### Opportunities for Future Improvement

- `dropSystem`'s `spawnDrops` scatter is private, so the Floor 3 payout
  re-implements the same two-stage scatter. If a third caller appears, promote a
  shared `spawnLootDrops(world, x, y, drops)` out of `dropSystem` instead of
  copying it again.
- A deterministic guard asserting "every entity class that can be defeated on a
  floor pays _some_ persistent reward" would catch the whole class of bug this
  slice fixed, rather than relying on a per-floor test.
