# ADR: Floor 6 opening economy access

## Status

Accepted

## Date

2026-09-27

## Estimated Complexity

🍎 x 1 — shared map spawn and scenario presentation adjustment with existing real-scene coverage.

## Context

The published Floor 6 dev start placed the player in a distant ingress while the first raiders immediately attacked the Broadcast Relay. A player using the normal direct start could lose Relay health before observing a raider, earning a requisition drop, or reaching a build plinth. The same experience also showed no actionable countdown.

## Decision

Place the shared map player spawn in the authored Broadcast Relay room beside the opening lane, and designate that room as the map spawn room. Derive the point from the Relay layout so the map geometry remains the source of truth. Present the actual time-to-next-wave in the scenario HUD.

Keep the generic floor timer hidden: Floor 6 has no generic time-expiry authority, so exposing its fallback `60:00` display would make a promise the scenario does not enforce. The direct-human, headless, and visual-runner paths continue to receive this behavior through the same Floor 6 map and scenario initialization.

## Consequences

### Positive

- The opening enemy drops are within ordinary player reach before the Relay can erase the first construction opportunity.
- Spawn-room consumers agree with the player’s real initial position.
- The visible countdown corresponds to a real upcoming wave rather than a cosmetic global clock.
- No floor-specific boot, renderer, or test-only gameplay path is introduced.

### Negative

- The player no longer begins in the authored ingress room; that room remains as the south access area.
- The wave countdown is a scenario HUD line rather than the standard top-center timer panel.

### Risks

- Changes to Relay geometry must keep the derived spawn point passable; the map test covers this and verifies the spawn-room role.
- A future Floor 6 global deadline needs explicit objective authority before the shared timer may be shown.

## Alternatives Considered

1. Increase starting requisitions or add a scripted grant — rejected because it would bypass real raider-drop economy and conceal the inaccessible opening.
2. Delay or weaken the opening raiders — rejected because it changes combat pacing without fixing player placement or observation.
3. Display the generic `60:00` floor HUD — rejected because Floor 6 does not enforce that timer.
4. Add a public-dev-only spawn override — rejected because human, headless, and visual-runner starts must share scenario initialization.
