# ADR: Director intro variant selection stays presentation-only

## Status

Accepted

## Date

2026-08-30

## Context

Floor scenarios need replay-varied Director intros without changing simulation
randomness. The selection must be stable for a run seed and floor, while the
authored copy must describe the floor's actual exit concept and first playable
objective.

## Decision

Select an authored intro variant from a hash of `(seed, floorId)` in the shared
scenario-presentation contract. Do not consume the world RNG stream.

Each registered floor supplies at least twenty distinct variants. The Floor 1
pool names its quest-to-boss-to-stairs route. The Floor 5 foundation states
that no escape route is available yet and directs the player to defend the
Command Post, whose destruction causes defeat.

## Consequences

### Positive

- Intro selection is reproducible and does not alter gameplay randomness.
- The renderer and each scenario use the same presentation contract.
- Player-facing floor guidance matches currently implemented progression.

### Negative

- Copy updates must preserve the authored-pool requirements.
- Floor 5 copy must be revised when later siege systems implement an exit.

## Alternatives Considered

### Consume the world RNG stream

Rejected because presentation variation would perturb deterministic simulation
state.

### Use one static intro per floor

Rejected because it does not provide the required run-to-run variation.
