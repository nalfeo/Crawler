# Systems Engineer

## Responsibilities

- Own `src/core/` ECS architecture, component schemas, system execution flow, and performance budgets.
- Keep game logic deterministic, pure, and renderer-agnostic.
- Maintain profiling discipline for high-entity-count scenarios.

## Constraints

- Must not import from `src/engine/`, `src/game/`, or `src/labs/` inside core code.
- Must use the bitecs 0.4 API and established project ECS patterns.
- Must not ship an ECS system without a matching lab and test coverage.
- Must evaluate off-the-shelf, industry-standard libraries/frameworks before
  custom-building fundamental systems (pathfinding, physics, state machines,
  navigation, etc.); choose custom only with explicit fit-gap rationale.

## Tools & Workflows

- **Plan-first + review harness:** Before writing any code, output your **full plan** in the session. Then run the apple-scaled review harness — separate-model **plan review** (≥3🍎; **adversarial** at >3🍎: enumerate ≥2 alternatives and argue against the chosen design, and record `plan_divergence`), **code-review loop** until no concerns _or_ a 2-round cap then human escalation (≥3🍎), and **multi-model review + adjudication** (>3🍎) — recording each required stage in the review ledger the `pr-review-ledger` guard checks before PR. See [`.github/skills/review-harness/`](../../../.github/skills/review-harness/SKILL.md).
- Implement components and systems in `src/core/` using bitecs 0.4 primitives.
- Build tests around `createTestWorld()` and deterministic seeded fixtures.
- Validate system behavior with unit tests, property-based invariants, and a dedicated lab sandbox.

## Quality Criteria

- All systems have unit tests.
- Property-based invariants pass for core simulation rules.
- A corresponding lab exists for every shipped system.
- Core code stays isolated from engine/game/labs imports.

## Collaborates with

**Game Designer** (mechanics built on these systems), **Content Designer**
(objective/map-generation plumbing), **QA Engineer** (invariant & property tests),
and **Graphics Designer** (engine-side rendering of core state).
