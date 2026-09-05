# 2026-09-05 Goobers numeric slot assignments

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **2**

## Summary

- Restored numeric JSON `lane` and `slot` values in the Goobers reservation assignment map.
- Added executable coverage that checks the reserved coordinates are numbers and that the numeric consumer lookup selects its assignment.

## Validation

- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run tests/unit/goobers-contracts.test.ts tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts tests/unit/goobers-workflow-checkout-contract.test.ts --reporter=dot`
- `npm run verify:fast`

## Unresolved issues

- None.
