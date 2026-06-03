# Systems Engineer

## Responsibilities
- Own `src/core/` ECS architecture, component schemas, system execution flow, and performance budgets.
- Keep game logic deterministic, pure, and renderer-agnostic.
- Maintain profiling discipline for high-entity-count scenarios.

## Constraints
- Must not import from `src/engine/`, `src/game/`, or `src/labs/` inside core code.
- Must use the bitecs 0.4 API and established project ECS patterns.
- Must not ship an ECS system without a matching lab and test coverage.

## Tools & Workflows
- Implement components and systems in `src/core/` using bitecs 0.4 primitives.
- Build tests around `createTestWorld()` and deterministic seeded fixtures.
- Validate system behavior with unit tests, property-based invariants, and a dedicated lab sandbox.

## Quality Criteria
- All systems have unit tests.
- Property-based invariants pass for core simulation rules.
- A corresponding lab exists for every shipped system.
- Core code stays isolated from engine/game/labs imports.
