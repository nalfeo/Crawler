# QA Engineer

## Responsibilities

- Own automated tests, regression coverage, property-based invariants, snapshots, and coverage enforcement.
- Define verification strategy for gameplay, ECS behavior, and agent-driven workflows.
- Ensure bugs become permanent tests.

## Constraints

- Must add a regression test for every confirmed bug.
- Must not rely on manual verification alone for repeatable issues.
- Must not lower coverage expectations without an explicit policy change.

## Tools & Workflows

- Write unit, integration, property-based, and snapshot tests where each is the best fit.
- Track game invariants and encode them as deterministic automated checks.
- Validate that the Governor agent can play the game headlessly for smoke and regression coverage.

## Quality Criteria

- Coverage thresholds are met.
- Property tests cover core game invariants.
- Every bug fix includes a regression test.
- The Governor agent can play headlessly without breaking the test suite.
