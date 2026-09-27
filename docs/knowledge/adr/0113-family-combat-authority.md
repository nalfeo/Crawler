# ADR 0113: Family relationships authorize combat

## Status

Accepted

## Date

2026-09-27

## Estimated Complexity

3 apples — shared combat eligibility, existing feud targeting, and pipeline parity.

## Context

Issue #4693 requires Floor 2 family relationships to affect real damage. The
existing feud prepass changes movement targets, but collision damage ignores
relationships and generic enemy teams prevent some rival attacks.

## Decision

Use a pure core family permission helper before damage and collision side effects.
Family permissions override generic enemy teams: hostile/hate families may hurt
the player, neutral/friendly families may not, and different families may hurt
each other. Player attacks retain their existing betrayal behavior. Keep the
existing collision broad phase and damage/death consumers; add throttled family
contact resolution there instead of a second combat system.

Capture family identity on delayed attacks and carry it through explosions;
resolve current player relations at impact. Extend the durable hit-signal pattern
from ADR 0042 to a bounded latest-hit entry per family. Friendly feud targeting
can defend its own family or the player against a valid living enemy. Movement
and attacks remain automatic.

Systems Engineer owns eligibility and damage; Game AI Engineer owns targeting;
QA owns deterministic and real MainGameScene parity evidence. Independent design
review confirmed this approach with pre-side-effect filtering, snapshot precedence,
and living-target validation required.

## Consequences

### Positive

- POS-001: Visual and headless combat share the same authority.
- POS-002: Forbidden collisions consume no hit, cooldown, or relation effects.
- POS-003: Existing bitecs collision and damage machinery remains authoritative.

### Negative

- NEG-001: Delayed attacks carry an additional family identity snapshot.
- NEG-002: Rival contact uses the existing 250 ms contact interval and can change
  Floor 2 encounters as required by the approved feature.

### Risks

- RSK-001: Recycled entity IDs must not redirect delayed damage or retaliation;
  family snapshots and generation checks protect these paths.
- RSK-002: Generic team handling must remain intact outside family combat.

## Alternatives Considered

- ALT-001: A new faction/combat library would duplicate existing deterministic
  bitecs systems and cannot resolve pipeline ownership better than this extension.
- ALT-002: AI-only filtering cannot protect direct, delayed, or incidental hits.
- ALT-003: A separate feud damage system risks duplicate hits and death processing.
