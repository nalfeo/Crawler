# Floor Factory achievement contract

## Verdict

Recommended. The approved issue is best implemented as a deterministic Floor
Factory planning contract rather than a runtime gameplay change.

## Apple estimate

2 apples.

## Changes

- Enforced achievement-owned or achievement-integrated QA coverage in the
  existing Floor Factory lint contract.
- Required dependency ordering, exactly one Owner declaration per node,
  measurable unlock/claim/reward-outcome evidence, and achievement-specific
  Playtester or Game Designer HUMAN_GATE coverage for numeric thresholds.
- Documented the contract and added fixture-backed regression coverage.

## Validation

The focused floor-epic lint unit suite and TypeScript typecheck pass. Existing
Floor 3 and Floor 6 epics remain intentionally non-compliant with the new
contract and report actionable violations.

## Systems touched

floor-epic-planning, achievement-contract-qa, agent-tooling
