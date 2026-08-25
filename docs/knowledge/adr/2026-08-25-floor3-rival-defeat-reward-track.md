# ADR: Floor 3 rival Companion defeats pay the persistent player reward track

## Status

Accepted

## Date

2026-08-25

## Estimated Complexity

🍎 x 2 — one additive `src/core/` store field plus one new `src/game/` reward pass;
no new lab, no new currency, no rebalancing.

## Context

Spec `.specify/specs/floor3-companion-league.md` R7 requires that defeated wild,
Trainer, and Studio Companions "drop **XP gems, gold, loot** exactly like other
floors", collected by the invulnerable player through the existing
`itemPickupSystem` into `world.playerLevel.xp` / `world.playerGold` /
`Inventory`. Player level is also what soft-gates Studio unlocks
(`FLOOR3_STUDIO_UNLOCK_LEVELS`), so this track is progression, not just flavor.

Half of that track already worked and half was structurally unreachable:

- **Wild pets** are plain `Enemy` entities, so `dropSystem` already rolls
  `BASIC_MELEE` + the manifest's `floor_3` table for them.
- **Rival roster Companions never die.** `companionKOSystem` deliberately clamps
  a Companion's `Health.current` back to `1` and raises `Companion.knockedOut`
  precisely "so `dropSystem`'s `[Enemy, Health]` kill query never observes 0 for
  it". `floor3ObjectiveTick` then calls `despawnFloor3EncounterRoster` to delete
  a defeated roster outright. Every death-driven reward path therefore skipped
  exactly the entities R7 names, and beating a Studio paid the player nothing.

Two extra constraints shaped the fix. Rival Companions can be **revived** by the
generic engagement-end recovery (spec R11), so any naive per-KO payout is
farmable. And the KOs that complete an encounter are despawned in the **same
frame** they happen, so a payout that observes KOs one frame later loses the last
Companion of every Studio.

## Decision

- **DEC-001**: Pay the reward at **KO**, not at death or at roster despawn. KO is
  Floor 3's death event for Companions, so `awardFloor3CompanionDefeatRewards`
  (new, `src/game/floor3CompanionRewards.ts`) pays every rival Companion with
  `knockedOut === 1` that has not been paid yet.
- **DEC-002**: Latch the payout in a new `companion.defeatRewarded` typed-array
  store field (`src/core/components.ts`), one shot per entity. This makes the
  R11 revive unfarmable, and it is EID-recycling-safe for free because
  `clearEntityStores` already zeroes every store slot on entity create/remove — a
  world-level `Set` would need its own purge discipline to match.
- **DEC-003**: Reuse the existing reward path end to end. Rivals roll
  `LOOT_TABLES.ELITE` (trained League combatants, not ambient wildlife) unioned
  with the floor manifest's `floorLootTableId`, and spawn via
  `spawnXpGem`/`spawnGold`/`spawnDroppedItem`. `itemPickupSystem` is untouched.
  No new currency and no new pickup kind, per R7's "this is the **only**
  persistent currency".
- **DEC-004**: Call the pass from the **head of `floor3ObjectiveTick`**. That tick
  runs in the canonical `postSystems` (`floorObjectiveSystem`), i.e. after the
  core step's `companionKOSystem` in the same frame and immediately before the
  same function despawns a wiped roster. It is already shared by both real
  pipelines (`createFloorMainSceneOptions` and `src/game/ai/headless-runner.ts`)
  through `ScenarioDefinition`.
- **DEC-005**: Never pay for Companions on `TeamId.PLAYER`. The player's own
  party going down is a loss condition, not income.

## Consequences

### Positive

- Spec R7's persistent player track is now complete on Floor 3: beating rivals
  feeds player XP/gold/inventory, which in turn feeds the Studio unlock gate.
- Balance stays authored in `loot-tables.ts`, so slice 16 can retune Floor 3
  payouts without touching runtime code.
- The payout is deterministic (`world.rng`, ECS query order) and therefore safe
  for seeded sweeps and replay.

### Negative

- Rival payout size is a first playable pass. `ELITE` + `floor_3` was chosen for
  consistency, not measured against a Floor 3 win-rate sweep.
- `dropSystem`'s two-stage scatter is duplicated in the new module because its
  `spawnDrops` is private.

### Risks

- **Reward-before-despawn ordering is load-bearing.** Moving the call out of
  `floor3ObjectiveTick` (e.g. into `afterSpawnerSystems`, which is spliced into
  `preSystems`) silently drops the encounter-completing payout. Pinned by
  `tests/unit/floor3-companion-rewards.test.ts` ("pays a wiped Studio roster …
  before that roster is despawned") and by the real-pipeline test
  `tests/integration/floor3-reward-track-pipeline.test.ts`.
- **The latch is the only anti-farm control.** A future path that clears or
  re-adds the `Companion` component to a live rival would reset it. The store
  field is documented in `components.ts` for that reason.

## Alternatives Considered

- **Reward inside `companionKOSystem` (core).** Rejected: it would push Floor 3
  roster/team policy and floor loot-table selection into `src/core/`, which must
  stay floor-agnostic.
- **Reward at `despawnFloor3EncounterRoster` (per wiped encounter).** Rejected:
  it pays nothing for a Trainer/rival KO'd outside a completed Studio wipe, and
  it turns per-defeat feedback into an end-of-encounter lump sum.
- **A new `afterSpawnerSystems` scenario entry.** Rejected: that slot runs in
  `preSystems`, before the core step's KO detection, so it observes KOs a frame
  late — and the wipe frame's despawn beats it every time.
- **Un-KO'ing rivals so `dropSystem` pays them like normal enemies.** Rejected:
  it would break the R5/R11 KO/recovery state machine that the whole Companion
  League fight model rests on.
- **Tracking paid rivals in a `WeakMap`/`Set` on the world.** Rejected: it
  duplicates recycling-safety logic that `clearEntityStores` already provides for
  store fields.
