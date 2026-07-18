# ADR 2026-07-18: Scoped Achievement Catalogs and Run-Global Fact Carryover

## Status

Accepted

## Date

2026-07-18

## Estimated Complexity

🍎 x 3 — touches shared achievement contracts, game/runtime evaluation, and world/carryover state

## Context

Achievement evaluation was hard-wired to Floor 1 with a single catalog and floor-local facts. The Floor 2 expansion requires explicit scope contracts so future floor-scoped achievements do not contaminate run-global rules, while preserving existing Floor 1 unlock behavior and deterministic ordering.

## Decision

1. Add explicit achievement scope contracts (`floor`, `current_run`) and floor-aware catalog lookup APIs.
2. Keep Floor 1 catalog behavior backward compatible by defaulting missing `scope` to `floor`.
3. Add deterministic run-global achievement fact state to world runtime state and carry it through existing floor-transition carryover snapshots.
4. Constrain `current_run` scoped rules to a run-global-safe fact subset at catalog-parse time.
5. Standardize floor-exit ordering with a shared helper that evaluates `run_end_clear` rules before snapshotting floor facts into run-global state.
6. Add an empty Floor 2 catalog seam and floor2 fact-collection seam now, without shipping new achievement content.

## Consequences

### Positive

- Floor-scoped lookup/evaluation can stay isolated per floor while still supporting run-global achievements.
- Run-global progress survives floor transitions deterministically and resets automatically on new run creation.
- Existing Floor 1 achievements remain compatible without catalog rewrites.
- Exit-ordering is explicit and reusable across floor transitions.

### Negative

- Achievement contracts and validation logic are stricter, so malformed future catalog entries fail fast.
- Additional state is now carried in the player carryover snapshot payload.

### Risks

- Future content authors must select facts that are legal for `current_run` scope.
- Runtime achievement identity remains id-based, so global id uniqueness across floor catalogs is now a hard requirement.

## Alternatives Considered

1. Infer scope implicitly from floor id and rule content. Rejected because it is brittle and prone to cross-floor contamination.
2. Store run-global progress in a separate singleton outside world/carryover lifecycle. Rejected due to reset/carryover drift risk.
3. Snapshot floor facts before run-end evaluation. Rejected because it risks run-end rule double-counting or ordering regressions.
