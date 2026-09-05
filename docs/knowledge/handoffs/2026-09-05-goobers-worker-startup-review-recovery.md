# 2026-09-05 Goobers worker startup review recovery

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## Summary

- The oldest live Goobers dispatch now retains reservation ownership when a newer dispatch is queued, preventing mutual suppression during a dispatch burst.
- An explicit-abandon recovery publishes a provisional slot assignment before closing its PR or deleting its branch, then clears its resume metadata in the final assignment map.
- The executable slot-concurrency suite now skips on workstations without `jq`.

## Validation

- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run tests/unit/goobers-contracts.test.ts tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts tests/unit/goobers-workflow-checkout-contract.test.ts --reporter=dot`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Apples

Estimated **3**, actual **3** — exact.
