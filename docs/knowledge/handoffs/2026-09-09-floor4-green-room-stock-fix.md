# Floor 4 Green Room stock fix

## Systems touched

inventory, mapgen, weapons

## Summary

Fixed the Floor 4 Green Room purchase transaction so the selected table is decremented by its table-qualified offerId instead of draining the same item across every sponsor table in the current visit. Added a deterministic unit regression that covers the duplicate-item multi-table case and verifies the selected sponsor's stock alone changes.

## Validation

- `npm run test:unit -- --run tests/unit/floor4-green-room-stock.test.ts`
- `bash scripts/agent/verify-fast.sh` (repo-wide fast gate was attempted; it still shows unrelated baseline-regression-check failures outside this floor4 patch)

## Risk

Low — the fix is localized to the Green Room purchase authority and the regression exercises the exact duplicate-item table-scope edge case without altering arena balance, spawn flow, or scenario wiring.
