# ADR: Floor 5 Ratings Ram uses split pre/post simulation authority

## Status

Accepted

## Date

2026-08-31

## Estimated Complexity

🍎 x 5 — adds authored gameplay state, ECS actors, runtime navigation
invalidation, scenario wiring, lab observability, and real-headless verification.

## Context

Floor 5 needs a deterministic Ratings Ram lifecycle that constructs, advances
along semantic map landmarks, strikes only the outer wall, can be destroyed and
rebuilt, and commits the breach exactly once. The breach changes collision and
navigation while also retiring all siege actors and outstanding spawn debt.

The real game and headless runner already share `ScenarioDefinition` hooks and
`floorObjectiveTick`. Damage and terminal outcomes must have one ordering
authority so simultaneous Command Post, wall, and ram lethality cannot diverge
between runtime paths.

## Decision

- Author ram timing, health, protection, route landmark order, strike behavior,
  and recovery cadence in the Floor 5 manifest. Resolve landmark positions from
  the authored siege-castle tile layout.
- Run `siegeRamSystem` from `beforeEnemyAISystems` after Floor 5 minion and Hero
  systems. It owns ram spawning, current-threat protection, movement, and the
  deterministic rebuild schedule, but not damage outcomes.
- Keep damage enforcement and outcome resolution in `floor5ObjectiveTick`.
  Resolve Command Post defeat first, then wall lethality, then ram lethality.
- Represent the sealed ingress with the shared dynamic barrier registry.
  Breaching drops that barrier, retires the ram, markers, wall, Hero, and
  minions, freezes the lane front, clears wave debt, and only then latches the
  `BREACHED` state.
- Include barrier registry versions in navigation cache signatures while
  continuing to consult live blocked tiles in pathfinding.
- Project the lifecycle and cleanup receipt through Floor 5 RunStats and the
  existing siege lab. Verify the complete lifecycle through the real headless
  pipeline with stall detection enabled.

## Consequences

### Positive

- Windowed and headless execution use the same system ordering and breach
  transaction.
- The wall cannot be bypassed by minion or unrelated damage.
- A `BREACHED` observer always sees collision opened and all cleanup complete.
- Route placement remains stable when the authored map layout moves.
- Current nearby threats can pause construction without historical Command Post
  damage permanently deadlocking a rebuild.

### Negative

- Floor 5 owns additional typed state and telemetry dedicated to one authored
  objective.
- The objective tick remains the required post-damage integration point for
  future Floor 5 siege actors.

### Risks

- Adding damage outside `floor5ObjectiveTick` could violate the terminal
  precedence contract.
- New navigation caches must include barrier versioning or consult the live
  barrier registry.
- Raising actor counts will require measuring the existing per-actor pathfinding
  cost before changing balance.

## Alternatives Considered

### Let the ram system apply and resolve damage

Rejected because it would split post-damage authority between pre-AI and
objective phases, making simultaneous terminal outcomes order-dependent.

### Mutate authored map tiles at breach time

Rejected because the generator owns the static layout. The existing dynamic
barrier registry already provides collision, projectile, rendering, and
pathfinding invalidation without rewriting map data.

### Hardcode world-space ram waypoints

Rejected because map re-authoring would silently desynchronize the escort route.
Semantic landmarks derived from tile layout preserve a single geometry source.

### Treat any Command Post damage as an active build-site attack

Rejected because Command Post health is not restored. A cumulative damage
predicate would permanently block every later rebuild; construction pressure
must reflect live nearby threats.
