# ADR 0093: Floor 4 Kept-Companion Co-Star

## Status

Accepted

## Date

2026-08-29

## Estimated Complexity

🍎 x 3 — consumes an existing carryover contract across Floor 4 scenario wiring, companion AI targeting, headless telemetry, and same-team projectile damage.

## Context

Floor 3 Slice 11 produces a `KeptCompanionContract` on the player carryover channel when a winning run keeps one party Companion at its ultimate form. Floor 4 Slice 8 must consume that contract as an optional additive ally. Runs without a carried companion must remain unchanged, and Floor 4 balance/progression must not depend on the co-star.

Companions are implemented as `Enemy + Companion + Team` entities so they can reuse movement, combat, health, and KO systems. That reuse creates a trust-boundary problem for Floor 4: player-team co-stars would otherwise be visible to generic `Enemy` scans, player auto-targeting, headless combat accounting, and enemy-projectile collision paths. Floor 4 also currently spawns wave and Headliner enemies without `Team`, which is fine for no-carryover runs but gives `companionAISystem` no rival team to target when a co-star exists.

## Decision

Floor 4 will re-host `playerCarryover.keptCompanion` during scenario initialization only when the validated carryover snapshot includes that optional contract. The co-star is spawned as a player-team roster Companion at the contract's adult form and final ability-milestone level, placed by a deterministic adjacent-passable-tile search near the player, and deliberately left without a `PartySlot` so it does not affect party caps or party-wipe semantics.

Floor 4 will wire `companionAISystem` in the canonical `beforeEnemyAISystems` slot. Floor 4 wave and Headliner enemies will receive `TeamId.ENEMY` only when a co-star exists, preserving no-carryover Floor 4 entity/component state. Shared hostile eligibility will exclude `TeamId.PLAYER` enemies so co-stars are ignored by player auto-targeting and headless hostile accounting, while core damage will treat same-team enemy projectiles as non-hostile to the player.

## Consequences

### Positive

- **POS-001**: Floor 4 gains the cross-floor co-star continuity promised by the Floor 3 kept-companion contract without adding a new persistence channel.
- **POS-002**: No-carryover Floor 4 runs preserve their existing wave, Headliner, and spawn-budget behavior because enemy team stamping is conditional on the co-star branch.
- **POS-003**: Player-team Companion entities are consistently treated as allies by player targeting, headless combat accounting, companion AI, and projectile damage.

### Negative

- **NEG-001**: Floor 4 now depends on Floor 3 companion species/archetype data to re-host the co-star, coupling the consumer to the producer's authored roster.
- **NEG-002**: Shared hostile eligibility now has a general player-team exclusion, so future systems that intentionally want all `Enemy` entities must bypass it and document why.

### Risks

- **RSK-001**: Future Floor 4 mechanics that count raw `Enemy` entities may accidentally include the co-star unless they use hostile eligibility or explicit wave/headliner ownership maps.
- **RSK-002**: Future kept-companion contract versions may need a versioned consumer adapter if the persisted shape grows beyond species/form/level-band semantics.

## Alternatives Considered

### Do Not Consume the Contract

- **ALT-001**: **Description**: Leave Floor 4 unchanged and keep `KeptCompanionContract` producer-only.
- **ALT-002**: **Rejection Reason**: This fails Floor 4 Slice 8's requirement to consume the contract as an optional co-star.

### Add a New Floor 4 Persistence Channel

- **ALT-003**: **Description**: Define a new Floor 4-specific companion carryover payload separate from `playerCarryover.keptCompanion`.
- **ALT-004**: **Rejection Reason**: The existing carryover channel already carries a validated contract; duplicating it would create drift and extra migration surface.

### Rebalance Floor 4 Around the Co-Star

- **ALT-005**: **Description**: Reduce player stats, increase wave budgets, or otherwise tune Floor 4 assuming the ally exists.
- **ALT-006**: **Rejection Reason**: The issue explicitly requires runs without a carried companion to remain unchanged and balance not to depend on the co-star.

### Make the Co-Star a Party Member

- **ALT-007**: **Description**: Recreate the kept companion through `recruitPartyCompanion`, assigning a `PartySlot` and using party-wipe semantics.
- **ALT-008**: **Rejection Reason**: Party membership would make the co-star affect party caps and death/progression outcomes, violating the additive ally requirement.
