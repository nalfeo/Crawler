# ADR: Personality-weighted objective portfolio

## Status

Accepted

## Date

2026-08-25

## Context

ADR 0062 made Floor 1 route ordering global and constraint-aware, but optional
work was still selected by bundle count. Merchant and spell intent producers
could advertise work, yet the planner could not express why one optional goal
suited an AI personality better than another. The behavior tree must remain the
tactical authority for combat, retreat, movement, and interaction.

## Decision

- Add the opt-in `objectivePortfolio` decision mode; keep `legacy` as the
  production default.
- Extend the existing exact route planner rather than introduce a second
  scheduler. Its portfolio contains every known pending required and optional
  goal, including rejected optional goals.
- Required goals remain non-droppable and the floor budget remains a hard
  constraint on optional inclusion. Utility can never compensate for missing a
  required deadline.
- Optional producers advertise fixed-point completion, optimization, safety,
  and exploration value. Persona presets provide corresponding weights and a
  travel/work cost penalty.
- The selected global route exposes one active objective to the behavior tree.
  The existing state/nav cache commits to that objective until objective state
  or navigation feasibility changes. Tactical branches may interrupt execution
  without choosing a different strategic objective.
- The first flagged implementation covers Floor 1, where a declarative global
  graph already exists. Other floors remain explicitly on their current
  strategic policy until they expose equivalent goal producers.

## Consequences

- Required and optional goals are considered by one deterministic authority.
- Seeded merchant admission becomes candidate production; route inclusion and
  ordering become personality-sensitive.
- Legacy callers that omit utility weights preserve bundle-count behavior.
- Exact search retains the existing 18-goal cap. Utility scoring adds bounded
  work to final-mask comparison without expanding the state space.
- Floor 2 settlement return remains a future producer migration rather than
  being presented as globally scheduled before Floor 2 has a goal graph.

## Alternatives considered

- A scheduler beside the exact planner was rejected because it would duplicate
  budget, prerequisite, and route authority.
- Replacing the full behavior-tree selector was rejected because tactical safety
  and movement execution are correctly modeled there.
- A Floor-1-only bespoke scorer was rejected because utility and portfolio
  semantics belong to the generic planner, even though initial runtime wiring is
  deliberately Floor 1 scoped.
