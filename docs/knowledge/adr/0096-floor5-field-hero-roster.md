# ADR 0096: Floor 5 field-Hero roster, role contracts, and respawn cadence

## Status

Proposed

## Date

2026-08-30

## Estimated Complexity

🍎 x 4 — touches a core ECS marker/store, Floor 5 scenario authority, shared
roster data/types, the floor manifest schema, lab display, and deterministic
headless + unit tests.

## Context

Floor 5 Slice 4 adds the castle's named defenders. The spec (`FR6.1`–`FR6.5`)
requires an append-only Hero roster drawn from an isolated RNG stream, each Hero
committed to exactly one strategic role for its whole lifetime, and a defeat and
respawn contract whose timing never depends on wall clock or on additional RNG
draws. The design bible fixes the eight content identities and their roles;
`HUMAN_GATE-3` fixes "one active field Hero at a time" and `HUMAN_GATE-4` assigns
within-role thresholds and cadence to the Game AI Engineer as tuning.

Slices 2 and 3 already established the lane-war and field-task contracts on this
floor: `siegeMinionSystem` owns pre-step minion strategy, `floor5ObjectiveTick`
owns post-damage objective authority (ADR 0095), and the Ratings Ram's
construction accounting belongs to Slice 3. Slice 4 has to add a boss-strength
actor into that running simulation without silently rewriting either contract.

The engine already has a telegraphed mob-ability runtime (`src/core/mob-abilities`)
and a shared tile pathfinder; Floor 5 should consume both rather than grow
parallel implementations.

## Decision

**Roster and draw.** `src/shared/floor5-heroes.ts` holds `FLOOR5_FIELD_HERO_ROSTER`,
an ordered, frozen, append-only array of the eight design-bible identities.
`buildFloor5FieldHeroCard` shuffles the entire roster **without replacement**
into a frozen "Hero card" exactly once, at floor init, from the manifest-reserved
`heroes` stream (`${seed}:floor5:heroes`).

**The draw cycle does not reset.** Each defeat advances a cursor into that frozen
card. When the eighth Hero falls, the slot becomes `retired`: permanently empty,
never refilled for the rest of the run. This is the spec's explicit "remain
defeated according to their slot" outcome.

**Respawn is fixed-tick and RNG-free.** Because the whole card is committed up
front, a respawn consumes zero RNG draws — the next Hero is already decided.
Cadence is manifest-authored in frames (`heroes.firstSpawnFrame`,
`heroes.respawnDelayFrames`, `heroes.activeSlots: 1`), never wall clock.

**One role for life.** `Floor5FieldHeroRole` is a closed union. A Hero's role
determines a single anchor rule, its engage/aggro/leash radii, and its one
telegraphed ability, for its entire lifetime. There is no cross-role fallback
ladder in target selection.

**Heroes engage minions only; they never damage structures.** Structures are role
_anchors_ — where a Hero holds — not Hero damage targets. A Hero expresses
pressure on an objective through position and its role ability.

**Authority follows ADR 0095's tick split.** `siegeHeroSystem` runs in
`beforeEnemyAISystems` and owns slot occupancy, spawn/respawn timing, role target
selection, and stance. `floor5ObjectiveTick` owns Hero contact damage and defeat
detection, post-damage, so the recorded defeat frame is the frame of the killing
blow.

**Abilities reuse the shared runtime.** Each role registers one
`MobAbilityRuntimeDefinition` through `registerMobAbility`. The adapters live in
`src/game/floor5HeroAbilities.ts` rather than `src/core/mob-abilities/` because
their resolve handlers read Floor 5 siege state; keeping them in the game layer
avoids a core→floor5 dependency.

## Consequences

### Positive

- **POS-001**: Same seed yields the same Hero draw order, and respawn timing is
  provably RNG-free because the card is committed before the first spawn.
- **POS-002**: A Hero's observed behavior is assertable against its declared role
  from headless telemetry alone (anchor distance, leash, build-site commitment).
- **POS-003**: Reusing the mob-ability runtime and the shared tile pathfinder
  means Floor 5 adds no second telegraph system and no second navigation kernel.
- **POS-004**: Restricting Heroes to minion targets leaves every Slice-2/3
  structural contract (checkpoint ownership, build-site pressure, Ram progress)
  exactly where its owning slice put it.
- **POS-005**: The roster is data, so Slice 5/6 and later floors can append
  identities without touching the decision kernel.

### Negative

- **NEG-001**: A run that kills all eight Heroes has no field Hero afterward.
  This is intended, but it means late-run castle pressure comes only from waves.
- **NEG-002**: Heroes are not tagged `Enemy` (consistent with ADR 0095), so the
  player's auto-targeting does not currently acquire them; player-facing
  targeting of siege actors remains a documented deferral.
- **NEG-003**: Floor 5 is the first production floor to enable the mob-ability
  runtime, so that runtime's behavior is now on the Floor 5 critical path.

### Risks

- **RSK-001**: Role tuning numbers (HP, damage, radii, cadence) are an AI
  Engineer baseline under `HUMAN_GATE-4`/`HUMAN_GATE-3`; the Game Designer owns
  any subsequent rebalance, and these values should not be changed to make a
  test or a win rate look better.
- **RSK-002**: Recycled EIDs could point the slot at a stranger; `siegeHeroSystem`
  revalidates the `SiegeHero` marker and live `Health` every tick and fails
  closed to `down` rather than steering a ghost.
- **RSK-003**: A future slice that gives Heroes structure damage would silently
  reopen the Slice-2/3 contracts this ADR deliberately protects.

## Alternatives Considered

### Reset the draw cycle when the roster is exhausted

- **ALT-001**: **Description**: Reshuffle and keep respawning Heroes forever.
- **ALT-002**: **Rejection Reason**: Unbounded attrition pressure, and it
  contradicts the spirit of a without-replacement contract. Boss-strength named
  defenders do not need infinite escalation, and the spec explicitly provides for
  a Hero remaining defeated according to its slot.

### Let the last drawn Hero repeat forever

- **ALT-003**: **Description**: Once the card is exhausted, keep re-fielding the
  final entry.
- **ALT-004**: **Rejection Reason**: Arbitrary — it privileges whichever identity
  the shuffle happened to place last, making late-run difficulty seed-dependent
  in a way no design decision asked for.

### Draw the next Hero at respawn time instead of committing the card up front

- **ALT-005**: **Description**: Consume one RNG draw from the `heroes` stream on
  each defeat.
- **ALT-006**: **Rejection Reason**: It couples RNG consumption to combat timing,
  which is exactly what `FR6.4` forbids. Committing the card makes the guarantee
  structural rather than a property that has to be re-argued each slice.

### Let Heroes damage and demolish structures

- **ALT-007**: **Description**: Allow a counter-push Hero to level the allied
  checkpoint, or an engine-disruption Hero to wreck the Command Post directly.
- **ALT-008**: **Rejection Reason**: Observed in the real headless pipeline to
  destroy an allied structure and to latch `buildSiteUnderAttack`, silently
  rewriting Slice-2 checkpoint ownership and Slice-3 construction rules that this
  slice does not own. Disruption is expressed through the engine-disruption
  ability's authored build-stall budget instead.

### Make the Hero a top-priority target for allied minions

- **ALT-009**: **Description**: Insert the live Hero ahead of structures in
  `selectFloor5Target` so the lane war wears it down naturally.
- **ALT-010**: **Rejection Reason**: Measured on seed 505 in the real pipeline: a
  165-HP defender parked on the lane soaked every allied minion indefinitely and
  stalled the Slice-2 push contract. The Hero is now a last-resort minion target,
  behind the lane objective; Heroes are meant to be worn down by the player.

### Build a bespoke Hero ability/telegraph system

- **ALT-011**: **Description**: Write Floor-5-specific telegraph and cast
  scheduling instead of registering into `src/core/mob-abilities/runtime.ts`.
- **ALT-012**: **Rejection Reason**: A second ability system would duplicate
  phase-machine, caster-validity, and telegraph rendering logic already proven on
  Floors 2 and 4, and would drift from them.
