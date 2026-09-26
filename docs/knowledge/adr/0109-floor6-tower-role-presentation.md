# ADR 0109: Floor 6 tower-role presentation

## Status

Accepted

## Date

2026-09-25

## Context

Floor 6 already has deterministic tower attacks and human build controls, but its
three existing towers expose only names, costs, and ranges. A player cannot
quickly connect a build choice with its intended combat job during the live
defense loop. The change must not alter combat targeting, costs, wave pacing,
or the renderer-neutral transaction authority established by ADR 0108.

## Decision

- **DEC-001**: Author a required non-numeric `roleLabel` beside each Floor 6
  tower definition in the validated floor manifest.
- **DEC-002**: Project that label through the existing pure Floor 6 HUD and
  construction snapshots, including the terminal-safe authored roster.
- **DEC-003**: Present the role in build choices, occupied-site inspection,
  and procedural world labels. The engine remains read-only and only forwards
  existing build, sell, and upgrade requests.

## Consequences

### Positive

- Players can distinguish rapid lane response, heavy Relay guard, and wide
  route coverage before committing requisitions.
- Headless replay evidence keeps the authored roles after terminal teardown
  removes floor-scoped tower entities.

### Negative

- The Floor 6 manifest and shared presentation contracts gain one required
  descriptive field.

### Risks

- Role copy can drift from future tuning; manifest review keeps both at the
  same authority boundary.

## Alternatives considered

### Infer roles from damage, cooldown, and range

Rejected: inference would make player-facing meaning fragile and can silently
change when approved balance tuning changes.

### Add renderer-owned combat-role state

Rejected: it would duplicate scenario authority and violate ADR 0108.
