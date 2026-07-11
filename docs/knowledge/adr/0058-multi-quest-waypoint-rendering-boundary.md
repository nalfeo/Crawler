# ADR 0058: Multi-Quest Waypoint Rendering Boundary

## Status

Accepted

## Date

2026-07-11

## Estimated Complexity

🍎 x 2 — extends an existing quest resolver and HUD widget without adding a new system.

## Context

The quest log supports multiple simultaneous active quests, but the waypoint
resolver returned only the tracked quest's current target and the HUD renderer
consumed only the first waypoint. Players therefore received no directional
guidance for other active quests.

Quest activity and objective targeting belong to the deterministic core layer.
Screen-edge placement, overlap handling, Phaser object lifecycle, and animation
belong to the engine layer. The fix must preserve that boundary while assigning a
stable rendered arrow to every visible active quest with a fixed target.

## Decision

- **DEC-001**: The core waypoint resolver returns all visible active quests with
  fixed directional targets in quest-log insertion order.
- **DEC-002**: Each waypoint carries its stable `questId`; the core does not
  calculate screen-space placement or presentation.
- **DEC-003**: The engine owns a keyed arrow, label, and pulse tween per quest ID.
- **DEC-004**: The engine applies deterministic screen-space fan-out when nearby
  arrows would overlap, while each arrow rotation continues to point at its true
  target.

## Consequences

### Positive

- **POS-001**: Every active targeted quest remains discoverable without changing
  which quest is expanded in the tracker.
- **POS-002**: Stable quest IDs allow render objects to be updated and removed
  independently as quests complete or targets enter the viewport.
- **POS-003**: Pure fan-out layout can be unit tested without Phaser, while the
  lab probe verifies real rendered object counts.

### Negative

- **NEG-001**: The HUD may create several arrow, text, and tween objects instead
  of a single fixed pair.
- **NEG-002**: Fanned arrow positions can be offset slightly from the target's
  exact screen-edge bearing to preserve legibility.

### Risks

- **RSK-001**: A very large number of simultaneous quests could crowd the edge
  ring; current quest volumes are small, and deterministic separation prevents
  the known three-quest overlap case.

## Alternatives Considered

### Keep arrows limited to the tracked quest

- **ALT-001**: **Description**: Preserve the original one-waypoint resolver and
  require players to switch the tracked quest for guidance.
- **ALT-002**: **Rejection Reason**: This directly violates the requirement that
  all active quests receive HUD arrows.

### Combine nearby quests into one counted arrow

- **ALT-003**: **Description**: Collapse overlapping targets into one arrow with a
  numeric badge.
- **ALT-004**: **Rejection Reason**: The chosen UX requires every quest arrow to
  remain individually visible and retain its own objective label.

### Resolve screen-space arrows in the core layer

- **ALT-005**: **Description**: Return final arrow coordinates and overlap offsets
  from the quest resolver.
- **ALT-006**: **Rejection Reason**: Camera zoom, viewport margins, pixels, and
  Phaser object lifecycle are rendering concerns and must not enter `src/core`.
