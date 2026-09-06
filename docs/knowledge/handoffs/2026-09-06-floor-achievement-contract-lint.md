# Floor achievement contract lint

## Systems touched

quests, docs-tooling, agent-personas

## Outcome

Recommended implementation, estimated at 2 apples. Issue #4383's empty body was
implemented as a Floor Factory planning contract rather than a runtime gameplay
change.

The floor epic lint now requires exactly one achievement-owning or
achievement-integrated QA node. The node must declare direct prerequisite
mechanic IDs in `prerequisite_mechanics` and depend on every declared mechanic,
preventing unrelated presentation or QA dependencies from satisfying the
contract. Documentation for both the Floor Factory agent and epic workflow
describes the new field and cardinality rule.

## Review findings addressed

- Added `achievement-slice-count` for duplicate achievement slices.
- Added deterministic prerequisite-marker enforcement and a regression fixture
  proving an unrelated dependency fails.

## Validation

- `npm exec vitest run tests/unit/agent/floor-epic-lint.test.ts --reporter=dot`
  — 52 tests passed.
- `npm run typecheck` — passed.
- `npm run verify:fast` — passed.
- Prettier check and `git diff --check` — passed.

## Notes

The existing Floor 5 epic remains an older non-conforming representative and
reports its pre-existing contract violations when run directly; no unrelated
epic content was rewritten. The compliant fixture and focused CLI path validate
the new contract.
