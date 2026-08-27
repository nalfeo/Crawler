# ADR 0092: Floor 3 biome overworld and wild spawns

## Status

Accepted

## Date

2026-08-23

## Context

Floor 3 needs seven affinity-themed overworld regions and ambient wild creatures
without adding a map model or a separate spawning pipeline. This touches map
generation, scenario configuration, the real simulation pipeline, and the
overworld observation lab.

## Decision

Reuse the cave-system generator's circular `TerritoryZone` representation with
one deterministic region per Floor 3 affinity. Interpret each zone's existing
numeric `familyIndex` as an index into `AFFINITY_RING` only in Floor 3 scenario
code, preserving Floor 2's family contract.

Reuse the ambient spawn director. At a spawn location, select same-affinity
species with 75% total weight and affinity-neutral species with 25% total
weight. Wilds use their species persona, the enemy team, and no owned-companion
tags. Wire the director through `ScenarioDefinition.afterSpawnerSystems`, rather
than the lab alone.

## Consequences

- Floor 3 map and wild selection remain deterministic through `world.rng`.
- The shared zone shape is reused without optional fields or Floor 3 data in
  shared map types.
- The scenario owns the affinity interpretation and wild-spawn policy.

## Alternatives considered

- Add a Floor-3-specific region type: rejected because it duplicates
  `TerritoryZone` and expands map consumers for no new capability.
- Put affinity selection in the generator: rejected because species data and
  spawn policy belong to the game scenario, not the portable map layer.
- Spawn wilds only from the lab: rejected because it would leave shipped and
  headless simulations without ambient creatures.
