# ADR 0046: Floor 2 ambient director with territory-weighted trash selection

## Status

Accepted

## Date

2026-07-06

## Estimated Complexity

🍎 x 2 - touches spawning + floor configuration without introducing a new runtime subsystem

## Context

Floor 2 was not playable in headless progression runs. Ambient trash pressure was effectively absent, and the spawning path had diverged from the proven Floor 1 director model. The floor brief required:

- 20-minute collapse timer behavior
- wider/more spacious cave generation
- deterministic Floor 2 starter weapon selection from seed
- territory-flavored trash composition (4 chosen types, quadrant-weighted 50/20/20/10)

Using a bespoke Floor 2-only respawn path increased drift risk and made it harder to reason about pacing parity with Floor 1.

## Decision

Adopt the Floor 1 ambient director pattern for Floor 2 and parameterize behavior through Floor 2 state/config:

1. Keep Floor 2 objective flow on `world.floorObjectiveTick`, but run ambient spawning through a director-style system every tick.
2. Seed and persist 4 neutral trash archetypes into quadrant territories (`N/S/E/W`) in `world.floorExtendedState`.
3. Select spawned trash archetypes by player quadrant using weighted mix:
   - 50% local quadrant type
   - 20% per adjacent quadrant type
   - 10% opposite quadrant type
4. Ensure ambient spawn-point logic selects the floor-appropriate enemy pack (`floor2EnemyPack` on Floor 2).
5. Apply floor brief tuning in the Floor 2 manifest (20-minute timer, wider cave geometry) and end the floor when collapse time reaches zero.

## Consequences

### Positive

- Reuses a known-good spawn control shape (director) instead of introducing another bespoke lifecycle.
- Preserves deterministic variety through seeded territory assignment.
- Keeps Floor 2 identity via quadrant weighting while matching Floor 1's continuous ambient pressure model.
- Makes floor pacing knobs data-driven in manifest where possible.

### Negative

- Floor 2 now depends more on shared director helpers, which couples behavior changes between floors unless guarded carefully.
- Objective tick currently carries both objective progression and ambient spawn orchestration, which can grow crowded.

### Risks

- Misconfigured per-floor pack selection can silently degrade spawn spacing/engagement behavior.
- Territory weighting can create local difficulty spikes if a selected archetype set is high-pressure for a given seed.

## Alternatives Considered

1. Keep a Floor 2-specific respawn subsystem and patch bugs in place.
   - Rejected: duplicates logic already solved by the director and increases long-term drift.
2. Uniform random trash selection from full Floor 2 pool.
   - Rejected: does not satisfy quadrant territory flavor and reduces navigational identity.
3. Static (non-seeded) territory assignment.
   - Rejected: weaker determinism and poorer seed-level reproducibility in headless diagnostics.
