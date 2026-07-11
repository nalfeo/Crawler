# ADR 0057: Floor 2 Family Encounter State

## Status

**Accepted**

## Date

2026-07-10

## Estimated Complexity

🍎 x 5 — coordinates progression, combat attribution, doors, HUD, and headless telemetry

## Context

Floor 2 family progression spans several runtime systems. Player-attributed trash kills
unlock a family's den, entering the den starts a boss battle, the den must remain locked
during that battle, and defeating the boss must update the family HUD and release the
door. The existing implementation derived these facts from transient combat events and
quest counters, while the boss HUD only understood Floor 1's objective state.

- **CTX-001**: Combat events are transient and cannot serve as durable run telemetry.
- **CTX-002**: Floor 2 intentionally owns its state in `floorExtendedState`, not the
  Floor 1-specific `floorScenario`.
- **CTX-003**: Door state is goal-driven; imperative door mutations race `doorSystem`.
- **CTX-004**: Floor 1 and Floor 2 both need the same top-of-screen boss health UI.

## Decision

Floor 2's extended state will own durable per-family trash-kill tallies and explicit
per-family boss encounter records. Quest counters remain the authored presentation layer
and are synchronized from player-attributed deaths. Each den door receives both an unlock
goal and a higher-priority encounter-active relock goal. Entering an unlocked den activates
its encounter; boss death clears the encounter goal and marks the family defeated.

The boss HUD will consume the shared encounter shape and select either Floor 1 objective
encounters or Floor 2 extended-state encounters without moving Floor 2 state into the
Floor 1 scenario model.

- **DEC-001**: `Floor2State` is authoritative for family trash-kill and boss-encounter
  state.
- **DEC-002**: Death events preserve source ownership and only player-attributed trash
  deaths advance Floor 2 family progression.
- **DEC-003**: Den encounter locking uses ADR-0010 goal-driven relock semantics.
- **DEC-004**: Cross-floor boss HUD resolution uses the existing shared encounter
  structure rather than a floor-specific adapter in the renderer.

## Consequences

### Positive

- **POS-001**: Family progression and headless telemetry read the same durable source.
- **POS-002**: Boss encounters have explicit activation, lock, defeat, and release states.
- **POS-003**: Floor 1 and Floor 2 share boss-bar behavior without sharing scenario state.
- **POS-004**: Player-only kill credit prevents ambient family combat from opening dens.

### Negative

- **NEG-001**: Floor 2 initialization and objective ticking own more explicit state.
- **NEG-002**: Damage producers must preserve ownership so death attribution remains
  accurate across projectile, beam, area, melee, and spell attacks.

### Risks

- **RSK-001**: A future player damage path that omits source ownership will deal damage but
  will not advance family kill progression; tests must cover every common weapon class.
- **RSK-002**: The 100-kill threshold may require later pacing work, but spawn density is
  deliberately unchanged until deterministic run evidence justifies a rebalance.

## Alternatives Considered

### Imperative Floor 2 Patch

- **ALT-001**: **Description**: Increment quest counters directly and mutate door state
  when the player crosses into a den.
- **ALT-002**: **Rejection Reason**: Transient quest/event state cannot provide reliable
  telemetry, and direct door mutation races the goal-driven door system.

### Reuse Floor 1 Scenario State

- **ALT-003**: **Description**: Populate `floorScenario.bossBattles` for Floor 2 and reuse
  the Floor 1 HUD path unchanged.
- **ALT-004**: **Rejection Reason**: Floor 2 intentionally stores its family simulation in
  `floorExtendedState`; introducing Floor 1 objective state would create conflicting
  ownership.

### Explicit Floor 2 Encounter State

- **ALT-005**: **Description**: Store family tallies and shared-shape encounter records in
  Floor 2 extended state and make consumers select the active floor's source.
- **ALT-006**: **Selection Reason**: This preserves floor boundaries while making
  progression durable, deterministic, and reusable by runtime and headless consumers.
