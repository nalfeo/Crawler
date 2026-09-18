# Handoff — Disable automated Copilot summons

## Systems touched

ci-policy, workflow-automation

## Summary

- Hard-disabled the entry jobs for issue intake, epic reprocessing, CI recovery incidents, CI Recovery reconciliation, Goobers runs, and empty-draft repair.
- Disabled the Copilot-assignment steps in deploy baseline reporting and nightly mutation reporting while preserving the surrounding deploy and mutation workflows.
- Added a table-driven workflow policy test covering every disabled entry job and mixed-workflow assignment step.
- Added the missing typed declaration twin for `handoff-retrieval.mjs`, restoring full-project TypeScript validation without weakening strictness.
- Independent review found the initially omitted CI Recovery workflow; its reconcile job and the policy test were updated before handoff.

## Apples

- Estimated: 3🍎
- Actual: 3🍎

## Validation

- `npx vitest run tests/unit/copilot-automation-disabled.test.ts tests/unit/baseline-regression-workflow.test.ts tests/unit/epic-workflow.test.ts tests/unit/goobers-lifecycle-ownership.test.ts` — 48 passed.
- `node --test .github/scripts/pr-ready-reviewer-guard.test.mjs .github/scripts/ci-recovery/issue-intake.test.mjs .github/scripts/merge-train/workflow-gating.test.mjs .github/scripts/goobers/intake-selection.test.mjs` — 138 passed.
- `npx tsc --noEmit --pretty false` — passed.
- `npx vitest run tests/unit/agent/handoff-retrieval.test.ts tests/unit/copilot-automation-disabled.test.ts tests/unit/baseline-regression-workflow.test.ts` — 19 passed.
- `git diff --check` — passed.
- `npm run verify:fast` — passed.

## Notes

- Workflow definitions and manual-dispatch metadata remain intact for auditability, but the relevant entry jobs have literal false conditions and cannot execute.
- The implementation code remains available so the automation can be deliberately restored by removing the explicit kill switches in a future reviewed change.
