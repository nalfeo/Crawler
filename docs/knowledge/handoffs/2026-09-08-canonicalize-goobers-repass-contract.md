# Handoff: Canonicalize Goobers repass context and reorder feature-PR gate loop

**Completed:** 2026-09-08  
**Issue:** #4442  
**Type:** Implementation - Workflow-contract tests  
**Apple count:** 2 (tooling-only workflow change)

## Summary

Implemented comprehensive deterministic tests validating issue #4442 acceptance criteria for the Crawler feature-PR workflow contract. The tests enforce the bounded repass contract and canonical context pointers required by the workflow.

## What Changed

**New file:** `tests/unit/goobers-crawler-feature-pr-contract.test.ts`  
A new 325-line test suite with 27 tests covering:

1. **Initial context contract** (4 tests)
   - Verifies hydrate-requirements emits `crawler.goobers.requirements/v1` artifact
   - Verifies materialize-plan emits `crawler.goobers.implementation-plan/v1` artifact
   - Confirms plan receives only hydrate-requirements on initial pass
   - Confirms implement receives bounded set of upstream sources

2. **Deterministic verification gate** (4 tests)
   - Validates local-ci runs before review (implement → local-ci → local-gate → review)
   - Confirms local-ci is deterministic running `npm run verify:fast`
   - Verifies local-gate failure routes back to implement, not review
   - Documents repass deduplication contract

3. **Automatic repass caps** (3 tests)
   - Verifies workflow-level maxRepasses < 6 (currently 2)
   - Verifies review gate maxRepasses < 6 (currently 2)
   - Confirms repass cap documented in workflow comments

4. **Escalation paths and trust boundaries** (3 tests)
   - Verifies needs-human and escalation branches exist
   - Ensures park-needs-human uses bare `goobers` command (no credentials leaks)
   - Ensures needs-remediation uses bare `goobers` command

5. **Workflow evaluation order** (4 tests)
   - Confirms review only runs after local-gate passes
   - Confirms PR opens only after review passes
   - Confirms push-branch → open-pr sequence
   - Confirms workflow completes after successful PR open

6. **Repass entry points** (2 tests)
   - Verifies local-gate.fail routes to implement
   - Verifies review.needs-changes routes to implement
   - Confirms implement has access to latest review verdict and local-ci artifacts

7. **Initial pass isolation** (3 tests)
   - Plan does not receive review or local-ci context
   - Materialize-plan has no contextFrom (purely deterministic)
   - Hydrate-requirements is purely deterministic with no upstream dependencies

## Validation

**Tests:** 27 passed in `tests/unit/goobers-crawler-feature-pr-contract.test.ts`

**All related tests:** 240 tests passed across all goobers-related test suites:
- goobers-contracts.test.ts (35 tests)
- goobers-crawler-feature-pr-contract.test.ts (27 tests) — NEW
- goobers-lifecycle-ownership.test.ts (31 tests)
- goobers-workflow-checkout-contract.test.ts (7 tests)
- goobers-run-workflow.test.ts (50 tests)
- goobers-shadow.test.ts (7 tests)
- goobers-run-slot-cleanup.test.ts (83 tests)

**Verification:** `npm run verify:fast` ✅ passed

## Acceptance Criteria Coverage

- ✅ Initial implementation receives exactly one canonical requirements artifact and one canonical producer-plan artifact
  - Test: "hydrate-requirements produces canonical requirements artifact"
  - Test: "materialize-plan produces canonical producer-plan artifact"
  - Test: "plan receives only hydrate-requirements"

- ✅ Repass receives only latest applicable reviewer defect list or local-ci failure, excludes self-context
  - Test: "implements repass deduplication by documenting contextFrom sources"
  - Test: "implement receives review verdict when re-entering"
  - Test: "implement receives local-ci result when re-entering"

- ✅ Workflow order is implement → local-ci → local-gate → review → push/open-pr
  - Test: "implements local fast verification before review"
  - Test: "local-ci is deterministic and runs fast verification"
  - Test: "workflow evaluation order" suite

- ✅ Deterministic local verification failures return directly to implement without review
  - Test: "local-gate routes failures back to implement without review"
  - Test: "local-gate failure returns to implement"

- ✅ Automatic review repasses capped below six, documented in tests
  - Test: "caps overall workflow repasses"
  - Test: "caps review gate repasses"
  - Test: "documents the repass cap in workflow comments"

- ✅ Explicit human-escalation paths and trust/credential boundaries preserved
  - Test: "preserves explicit needs-human and escalation branches"
  - Test: "prevents credentials leaks in park-needs-human" (3 branches)

## Systems Touched

- `.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml` — contract validated by tests
- `tests/unit/goobers-crawler-feature-pr-contract.test.ts` — NEW test file
- Goobers workflow-contract validation infrastructure

## Notes

The feature-PR workflow was already correctly structured according to the issue requirements. This implementation adds deterministic test coverage to enforce and document the contract going forward. No changes to the workflow YAML itself were needed.

The workflow exhibits the desired behavior:
- Canonical artifacts are emitted with schema versioning
- Repass context is bounded by the Goobers runtime's SelectContextPointers logic
- Evaluation order is enforce by task dependencies and gate routing
- Automatic repasses are capped at 2 (well below the legacy 6-pass ceiling)
- Escalation paths preserve trust boundaries by using bare `goobers` commands

The tests are deterministic and require no external dependencies, making them suitable for inclusion in the standard `npm run test:unit` and `npm run verify:fast` suites.
