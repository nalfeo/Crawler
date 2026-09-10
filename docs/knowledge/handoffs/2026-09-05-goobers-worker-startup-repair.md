# 2026-09-05 Goobers worker startup repair

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## Summary

Repaired the production Goobers intake outage where all hosted slots entered the pinned runtime's nested `backlog-query --claim` stage and failed to find `instance.yaml`.

- The serialized reserve job now selects, validates, and reserves up to four distinct issues before either runner lane starts, assigning them deterministically to lane 1/slot 1, lane 1/slot 2, lane 2/slot 1, and lane 2/slot 2.
- Every launched hosted slot receives an explicit issue, intake cohort, and optional resume metadata. Unassigned slots remain idle and never start Goobers.
- The Goobers definition fails closed when a hosted slot lacks an explicit assignment, before the pinned nested backlog-query path can execute.
- Adoption, disposition, result comments, disposal receipts, and failed-run reservation release now resolve ownership from the assignment map. Journal-less records are synthesized only for assigned slots, so unused slots cannot emit stale-label remediation for an unknown issue.
- A live sibling dispatch suppresses all new slots, preserving the global four-task ceiling and exclusive reservation ownership while the existing dispatch runs.

## Validation

- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run tests/unit/goobers-contracts.test.ts tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts tests/unit/goobers-workflow-checkout-contract.test.ts --reporter=dot`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Apples

Estimated **3**, actual **3** — exact: the repair stayed within the hosted workflow, Goobers definition, and deterministic contract tests.
