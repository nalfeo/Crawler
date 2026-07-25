# ADR 0074: Squick Undercity burst dispatch and status ownership

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 2 — targeted PR recovery across existing typed ability/runtime surfaces

## Context

The Squick UNDERCITY MOB CALL PR shipped deterministic runtime geometry, but two
cross-layer defects remained:

1. `pendingBursts` queued only geometry, so the engine renderer could not
   distinguish ability-specific resolution VFX and always rendered the generic
   Verdigris burst.
2. Floor 2 status metadata accidentally attached Squick runtime/arena evidence
   to Nana's ability entry, causing catalog/status assertions to fail and
   misreporting delivery state ownership.

## Decision

- **DEC-001**: Carry ability identity with burst geometry by changing the
  pending-burst queue payload to `{ abilityId, geometry }`.
- **DEC-002**: Dispatch burst rendering by `abilityId` in `MobAbilityVfx`,
  preserving the existing generic burst path and adding an Undercity-specific
  path for `plague-boss-squick-undercity-mob-call`.
- **DEC-003**: Restore Nana to planned/blocked status and attach Squick's
  runtime, telegraph, arena evidence, and implementation issue/PR references to
  Squick's own status entry.

## Consequences

### Positive

- Squick resolution effects are now ability-addressable without introducing a
  switch in core runtime logic.
- Status reporting matches the canonical ability ownership and unblocks the
  Floor 2 status/catalog test contract.

### Negative

- The burst queue contract changed shape, requiring test updates where
  `pendingBursts` is populated directly.

### Risks

- Future ability IDs must be matched correctly in renderer dispatch; unknown IDs
  intentionally fall back to the generic burst path.

## Alternatives Considered

### Keep geometry-only queue

- **Rejected**: cannot render ability-specific visuals from renderer-only state.

### Encode Squick visuals in generic burst

- **Rejected**: couples unrelated ability visuals and regresses Verdigris style
  clarity.
