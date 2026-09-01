# ADR 0101: Floor 6 authored-site towers

## Status

Accepted

## Date

2026-09-01

## Estimated Complexity

🍎 x 5 — deterministic ECS construction, combat, data validation, and lifecycle wiring span core, game, and shared layers.

## Context

Floor 6 needs player-requested defensive towers without allowing UI state ownership or construction that changes the authored raider routes. Existing combat damage primitives, route geometry, run-scoped currency, and terminal cleanup are already available.

## Decision

Use manifest-validated tower definitions and a Floor 6 state occupancy ledger keyed by immutable authored site IDs. Create tagged ECS tower entities only after an atomic transaction succeeds. The Floor 6 scenario selects nearest in-range, line-of-sight raiders with an EID tie-break and uses the existing damage primitive. Terminal cleanup removes all tower entities and ledger entries.

## Consequences

### Positive

- **POS-001**: Construction cannot mutate map topology because transactions accept only existing geometry site IDs.
- **POS-002**: The same state and targeting rules execute in visual and headless pipelines.

### Negative

- **NEG-001**: Tower combat remains Floor 6-specific rather than becoming a reusable general tower framework.
- **NEG-002**: Starter values are operational defaults pending the Floor 6 balance pass.

### Risks

- **RSK-001**: Future projectile or summon tower variants must preserve bounded entity lifecycles and extend the ledger deliberately.

## Alternatives Considered

### UI-owned placement state

- **ALT-001**: Store occupancy and costs in rendering/UI state.
- **ALT-002**: Rejected because headless replay and atomic transaction guarantees require simulation authority.

### Dynamic map-blocking construction

- **ALT-003**: Add barriers or terrain edits at tower placement.
- **ALT-004**: Rejected because it can alter route topology and invalidate the authored defense contract.
