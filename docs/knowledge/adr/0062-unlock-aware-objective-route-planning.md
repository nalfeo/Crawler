# ADR 0062: Unlock-aware objective route planning

## Status

Accepted

## Date

2026-07-15

## Estimated Complexity

🍎 x 5 — replaces cross-layer Floor 1 objective ordering and hypothetical door navigation

## Context

Floor 1 AI previously encoded quest progression as source-ordered behavior-tree
branches. That ordering caused repeated long trips between independent objective
clusters and produced seven high-progression timeouts in the authoritative
600-run baseline. Reordering individual branches would only optimize the current
Floor 1 layout and would drift from the true door-unlock dependency graph.

The AI has perfect knowledge of known objectives. It must select the shortest
feasible route through every required objective, consider optional objectives in
the same route, preserve floor completion when optional work does not fit, and
remain deterministic. Route feasibility depends on effects produced by earlier
goals because those effects change door passability.

Stakeholders are the game maintainer, AI/planning implementers, quest designers,
and map/door-system maintainers.

## Decision

Represent Floor 1 progression as a declarative goal graph and solve it with an
exact deterministic state-space planner.

- **DEC-001**: Goal nodes declare stable IDs, locations, work costs,
  prerequisites, required/optional status, optional bundle IDs, and unlock
  effects.
- **DEC-002**: Search state is `(completedGoalMask, currentLocation)`. The
  planner maximizes included optional bundle count, then minimizes total
  travel/work cost, then breaks ties lexicographically by stable goal ID.
- **DEC-003**: Required goals are never removed to satisfy a budget. Optional
  bundles are all-or-nothing and are dropped when they threaten completion.
- **DEC-004**: Runtime route evaluation uses strict door-aware A\* under the
  hypothetical effects produced by the candidate route. Unreachable edges are
  `Infinity`; there is no Euclidean success fallback.
- **DEC-005**: ETA/slack planning and runtime behavior share the goal graph but
  may use different travel oracles: pure straight-line estimates for the
  world-independent ETA path and live door-aware A\* for runtime decisions.
- **DEC-006**: Active detours carry explicit graph goal identity. The planner
  charges committed travel once and propagates the committed goal's effects to
  downstream prerequisites.

## Consequences

### Positive

- **POS-001**: Objective order follows dependencies and current geometry rather
  than hardcoded quest sequence.
- **POS-002**: Required and optional work are optimized together with a
  deterministic, measurable completion policy.
- **POS-003**: The seven targeted timeout pairs now all complete Floor 1 within
  six minutes without enemy or weapon balance changes.
- **POS-004**: Goal dependencies and hypothetical door effects are testable as
  pure data instead of being implicit across behavior-tree branches.

### Negative

- **NEG-001**: Floor progression now has an additional declarative model that
  must stay synchronized with quest completion and door-lock semantics.
- **NEG-002**: Exact search is exponential, so pending goals are capped at 18.
- **NEG-003**: Runtime planning performs deterministic A\* queries and therefore
  requires state-aware caching to avoid per-frame recomputation.

### Risks

- **RSK-001**: Missing or incorrect unlock effects can make a valid required goal
  appear unreachable. Planner errors intentionally surface instead of silently
  restoring hardcoded ordering.
- **RSK-002**: Future goal graphs approaching the 18-node cap may require
  decomposition or a different search strategy.
- **RSK-003**: ETA straight-line costs may rank close alternatives differently
  than runtime A\*, although both paths preserve the same dependency contract.

## Alternatives Considered

### Hardcoded behavior-tree reordering

- **ALT-001**: **Description**: Move the known shop and spell branches into the
  order that wins the current failing seeds.
- **ALT-002**: **Rejection Reason**: It encodes map-specific ordering, cannot
  adapt to geometry, and repeats the source-of-truth drift that caused the
  failures.

### Pairwise nearest-objective selection

- **ALT-003**: **Description**: Greedily choose the currently nearest pending
  objective.
- **ALT-004**: **Rejection Reason**: Greedy distance cannot model future door
  unlocks, prerequisite chains, optional bundles, or globally shortest routes.

### Hierarchical room-route heuristics

- **ALT-005**: **Description**: Rank room clusters first, then apply fixed quest
  ordering within each cluster.
- **ALT-006**: **Rejection Reason**: It remains heuristic, duplicates map/quest
  semantics, and cannot prove optimality for the small bounded Floor 1 graph.
