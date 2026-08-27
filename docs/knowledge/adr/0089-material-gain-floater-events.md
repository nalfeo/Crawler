# ADR-0089: Material gain floater events

## Status

Accepted

## Date

2026-08-22

## Estimated Complexity

🍎🍎🍎 — extends the shared floater contract through core inventory sources and engine rendering with regression coverage.

## Context

Harvested materials and material floor drops updated inventory without immediate
world-space acknowledgement. The existing floater queue and `CombatVfx` already
provide a deterministic, layer-safe presentation path for non-combat notices.

## Decision

Add a `materialGain` floater event kind. `harvestSystem` emits it after granting
a harvested item, and `itemPickupSystem` emits it only for dropped definitions
tagged `Materials`. Both emit `+1 <item name>` at the item position. `CombatVfx`
renders the event using the existing non-combat floater lifecycle and a
material-specific style.

Maintain ECS and renderer tests, plus a deterministic `MainGameScene` test that
picks up `iron-ore` and observes the live `+1 Iron Ore` text.

## Consequences

### Positive

- Material collection is acknowledged at the interaction point without coupling
  core systems to Phaser.
- Non-material floor drops do not add visual noise.
- The real-scene regression test protects the complete event-to-renderer path.

### Negative

- The shared floater-event union and renderer style switch gain another case.

### Risks

- Future stack sizes other than one must emit the actual granted quantity rather
  than retaining the current `+1` label.

## Alternatives Considered

1. **Reuse combat events.** Rejected because a material gain is not a combat
   result and would dilute that event contract.
2. **Render directly from pickup and harvest systems.** Rejected because it
   would violate the core-to-engine boundary.
3. **Show all floor-drop pickups.** Rejected because unrelated pickups would
   create avoidable floater noise.
