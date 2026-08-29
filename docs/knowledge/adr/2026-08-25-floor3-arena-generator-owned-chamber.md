# ADR: Floor 3 generator-owned Final Four arena chamber

## Status

Accepted

## Date

2026-08-25

## Estimated Complexity

🍎 x 3 — crosses core map generation and game scenario placement, with regression tests.

## Context

Floor 3's Studio objective flow selects seven territory rooms for the seven Studio
encounters. The Final Four is a terminal encounter, but it previously had no
dedicated generated room: when no unused territory room remained, scenario code
fell back to center-biased tile placement. That made the encounter depend on a
non-room fallback instead of authored room geometry, and it could place the
`floor3-final-four-arena` set piece outside an explicit room contract.

This change spans `src/core` map generation and `src/game` scenario selection, so
the room ownership and fallback contract need a durable decision.

## Decision

The Floor 3 cave-system generator owns Final Four arena geometry:

- carve and register one deterministic 10×10 `BOSS_STAIR` room labeled
  `floor3_final_four_arena`;
- keep the room sealed except for one door, while carving an exterior bypass ring
  so the chamber cannot partition cavern connectivity;
- expose the room through the existing `RoomGraph`/`FloorMap` contract, not a
  Floor-3-only side channel.

The Floor 3 scenario resolves the Final Four encounter by finding that labeled
`BOSS_STAIR` room and stamping the existing authored
`floor3-final-four-arena` set piece there. Territory-room selection remains the
fallback only for explicit test/map overrides that omit generator-produced arena
geometry.

## Consequences

### Positive

- The Final Four has a deterministic, named room contract in generated Floor 3
  maps.
- Studio territory allocation no longer competes with the terminal encounter's
  arena placement.
- Scenario code stays data-driven through `RoomGraph` lookup instead of owning
  post-generation carving.
- The exterior bypass ring preserves cavern reachability even when the sealed
  arena occupies central topology.

### Negative

- Floor 3 generation now reserves a fixed central chamber footprint for the
  terminal encounter.
- `BOSS_STAIR` carries a Floor-3-specific label so scenario code can distinguish
  this chamber from other terminal/boss-stair concepts.

### Risks

- Future Floor 3 room consumers must treat the label as the specific Final Four
  contract; role alone is intentionally too broad.
- If the arena size changes, generator reachability tests and set-piece spawn
  fan-out expectations need to move together.

## Alternatives Considered

1. **Scenario-owned post-generation carve/stamp**
   - Rejected: scenario code would bypass the generator's reachability,
     culling, and retry ownership, making the real map topology harder to
     validate.
2. **Reuse an unused territory room**
   - Rejected: seven Studios can exhaust all seven territory rooms, which is the
     exact failure mode this ADR addresses.
3. **Introduce a new shared `RoomRole` for the Final Four**
   - Rejected: `BOSS_STAIR` already models terminal boss-style chambers; the
     stable label is sufficient to identify the Floor 3 arena without expanding
     every room-role consumer.
