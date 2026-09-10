# ADR 0104: Floor 3 Studios use canonical quest navigation

## Status

Accepted

## Date

2026-09-04

## Estimated Complexity

🍎 x 4 — connects shared quest data, core waypoint resolution, game progression, and engine HUD layout.

## Context

Floor 3 Studio encounters exposed progression through a bespoke Studio-facing
surface instead of the standard quest tracker and waypoint guidance. The issue
report button also occupied a corner stack that could obstruct or be obscured
by supported HUD surfaces. The canonical quest system already owns active
objective display and direction arrows, but Studio rooms need a deterministic
world anchor because their roster is selected per run.

## Decision

Define one data-driven goal quest for each Studio candidate in the shared Floor
3 quest pack. When a selected Studio unlocks, accept its quest through the
existing quest system. Resolve its defeat goal in the core waypoint resolver to
the selected room's deterministic anchor, using the room-bounds center only
when no explicit interior anchor exists. Keep precise target coordinates
separate from shared-room direction coordinates.

Anchor the issue-report button permanently in the safe-area-aware bottom-right
of the design viewport. Preserve modal clickability by changing depth only,
rather than moving the button into another HUD corner.

## Consequences

### Positive

- Studios appear in the same quest tracker and waypoint pipeline as other
  objectives.
- Room guidance is deterministic in both the real game and headless probes.
- The issue button has a stable, testable location clear of the top HUD and
  remains available while panels are open.

### Negative

- The quest registry includes ten candidate definitions even though only the
  selected six are accepted during a run.
- A bottom-right button consumes a small amount of otherwise available safe-area
  space on compact viewports.

### Risks

- Future Studio room-generation changes must preserve a walkable anchor or the
  deterministic bounds-center fallback.
- New bottom-right HUD surfaces must include the issue button in their overlap
  contract.

## Alternatives Considered

- Add a dedicated Studios objective panel: rejected because it duplicates the
  canonical tracker and creates a second source of navigation state.
- Point arrows at each Trainer entity: rejected because roster positions are
  transient and can produce unstable guidance; the room anchor is the stable
  objective location.
- Move the issue button to the opposite top corner while panels are open:
  rejected because it changes location and can collide with minimap/tracker
  surfaces.
