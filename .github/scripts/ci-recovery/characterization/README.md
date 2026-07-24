# CI-recovery characterization fixtures

Deterministic offline fixture catalog for the harness redesign baseline.

- `reconcile-decision-fixtures.json` pins 34 reconcile decision points (R01-R34).
- Every decision is tagged with deadlock class `D1`-`D10` from the holistic review.
- `coverageBy` points at concrete existing `reconcile.test.mjs` cases that currently exercise each decision.
- `lease_transition_fixtures` pin owner/status transition verdicts in `state.mjs`.
- `absorbed_regressions` inventories superseded coverage from PRs #1782, #1797, #1833, #1813, and #1791.
