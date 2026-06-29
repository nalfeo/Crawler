# ADR 0031: Quest waypoints + HUD direction arrows for Floor 1 findability

## Status

Accepted

## Date

2026-06-28

## Estimated Complexity

🍎 x 3 — pure core resolver + two engine HUD touch points + lab + tests; no new sim coupling.

## Context

Floor 1 is now large enough that the human player survives the timer easily but
frequently cannot _find_ the next quest objective. Two fixes were on the table:
inflate the floor time limit, or surface the objective location. Time was not the
bottleneck — navigation was — so a longer timer would mask the symptom without
fixing the experience.

## Decision

Add a deterministic core resolver `getQuestWaypoints(world)` mapping the tracked
quest's first active objective to ≤1 world position, and render it two ways in the
HUD: a gold minimap marker (overlay + radar) and an off-screen edge direction
arrow with a distance label. The resolver lives in `src/core/` (no rendering
imports); rendering lives in `src/engine/` and consumes the resolver. The floor
timer is left unchanged.

## Consequences

### Positive

- Players can locate objectives without timer inflation.
- Resolver is pure/deterministic and unit-tested per quest stage; HUD stays dumb.
- Minimap markers ungated on visited so they guide toward unexplored rooms.

### Negative

- Two-layer change (core + engine), so HUD must stay in sync with quest stages.

### Risks

- Markers could over-handhold; mitigated by showing only the single active step.

## Alternatives Considered

- **Longer floor timer** — masks navigation pain, doesn't fix findability.
- **Always-on full map** — removes exploration tension; rejected.
