# ADR 0110: Floor 5 objective-driven siege escalation

## Status

Accepted — 2026-09-25.

## Context

Floor 5 already required player-owned combat, movement, and interactions to
advance the siege, and hostile siege actors already participated in ordinary
weapon targeting. The battlefield still opened at a small fixed density and
did not respond visibly to objective progress. Raising the original authored
wave cap globally would make elapsed time, rather than player actions, the
source of pressure and would mix objective reinforcements into authored wave
accounting.

## Decision

- Start with the existing four-hostile opening pressure. Completing supplies,
  the control point, Ram construction, and Ram escort raises the hostile lane
  cap by three, to a hard maximum of sixteen, and queues the same number of
  deterministic enemy minions.
- Objective reinforcement minions are lighter pressure (6 HP, 1 damage on a
  1,000 ms cooldown) than the authored opening wave. Density escalates without
  making the Command Post mathematically dependent on a test-only damage path.
- Track objective reinforcement debt separately from the immutable authored
  wave ledger. Reinforcement minions reuse an enemy manifest archetype and the
  existing spawn/combat/lifecycle path, but do not falsify authored wave timing.
- Gate breach and throne approach remain named escalation beats. They emit
  presentation cues but do not queue lane minions: breach atomically freezes
  and cleans the lane, after which the authored courtyard and throne actors own
  pressure.
- The Hero ceiling is two. The current manifest intentionally retains one
  active Hero slot, so this slice may field at most one simultaneously; the
  first completed escalation beat may bring that deterministic authored Hero
  forward before the frame-600 fallback.
- Project current minion density, the rising 16-minion cap, the two-Hero
  ceiling, and completed escalation beats through the existing scenario HUD.

## Consequences

Idle time cannot create objective reinforcement debt. Existing automatic
weapons target the new hostiles through the already accepted `Enemy` adapter,
while the objective pilot must move into weapon range and actively clear threats
around the build site and Ram to progress. Breach/capture cleanup remains
authoritative and bounded.

The initial 16/2/+3 tuning is deliberately provisional. Later playtesting may
change those values without changing the event-driven contract.
