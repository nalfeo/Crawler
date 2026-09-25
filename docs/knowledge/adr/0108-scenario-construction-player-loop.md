# ADR 0108: Scenario construction player loop

## Status

Accepted

## Date

2026-09-19

## Estimated Complexity

Touches the scenario, shared presentation seam, and real scene controls and rendering.

## Context

Floor 6 exposes building through normal input, but occupied sites reject inspection,
selling has no player control, and upgrade purchases have no player control.
Relay, routes, and pads need world presentation. Existing deterministic transactions
already implement the intended economy; this change must preserve their rules.

## Decision

- **DEC-001**: Extend the existing optional construction contract with pure snapshots
  of action permissions, occupied towers, refunds, upgrade effects and availability,
  Relay health/position, and authored route geometry in feet.
- **DEC-002**: Requests call the existing scenario build, sell, and purchase
  transactions. The engine reads snapshots and never mutates economy or ECS state.
- **DEC-003**: Reuse Phaser graphics/text and the existing modal picker. Inspection
  remains available when transactions are locked. Site and Relay interactions expose
  upgrades. Procedural shapes, labels, tint, and range markers convey world identity.
- **DEC-004**: Keep combat roles, enemy behavior, prices, and pacing unchanged.
  Independent design review approved this extension before implementation.

## Consequences

### Positive

- **POS-001**: Human controls share the simulation's transaction authority.
- **POS-002**: No new UI framework or parallel game state is required.
- **POS-003**: Normal pointer-input scene tests can prove the earned-currency loop.

### Negative

- **NEG-001**: Construction snapshots carry more semantic presentation data.
- **NEG-002**: Procedural placeholders remain a temporary art treatment.

### Risks

- **RSK-001**: Touch gestures and modal transitions can leak clicks to world sites;
  clear queued interaction input and reject blocked pointer gestures.
- **RSK-002**: Snapshot availability may change before a request; transactions must
  revalidate and the UI must present the returned result and fresh snapshot.

## Alternatives Considered

### Direct renderer mutations

- **ALT-001**: Rejected because they duplicate authority and violate layer rules.

### New economy or UI framework

- **ALT-002**: Rejected because existing transactions, Phaser primitives, and the
  shipped picker already supply the required behavior and input integration.

### HUD text alone

- **ALT-003**: Rejected because a fresh player needs visible world affordances and
  usable actions, not only a telemetry description of unavailable controls.
