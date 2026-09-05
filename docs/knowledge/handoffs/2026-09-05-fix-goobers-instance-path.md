# Fix Goobers isolated-instance intake path

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended** — scheduled Goobers intake was blocked before claim
  by a reproducible instance-path contract failure.
- Apple estimate: **3**

## Summary

Scheduled Goobers Run `33981194863` launched four isolated slot roots
successfully, but every `query-backlog` stage failed with
`read instance.yaml: open instance.yaml: no such file or directory`.

The Actions workflow initially writes `GOOBERS_INSTANCE` into each temporary
slot manifest, then runs `goobers config materialize`. Materialization replaces
that manifest with the checked-in `.goobers/instance.yaml.example`. The
checked-in manifest did not allow `GOOBERS_INSTANCE` through the executor's
default-deny environment, and `run.script` does not receive Goobers' automatic
`GOOBERS_INSTANCE_ROOT` context. The nested `goobers backlog-query --claim`
therefore fell back to `.` in the stage worktree and looked for bare
`instance.yaml`.

Added `GOOBERS_INSTANCE` to the canonical source manifest's
`runner.envPassthrough`. The regression test now executes the real
`query-backlog` script from a different cwd using the environment permitted by
the manifest that survives materialization, and requires the nested claim to
receive the absolute isolated slot root.

No feedback issue, claim, assignment, or queue label was mutated while proving
the repair.

## Validation

- `node .github/scripts/validate-goobers-contracts.mjs` — 9 workflow schemas
  and 19 fixtures passed.
- `npx vitest run --project unit
tests/unit/goobers-workflow-checkout-contract.test.ts
tests/unit/goobers-run-workflow.test.ts
tests/unit/goobers-run-slot-cleanup.test.ts
tests/unit/goobers-contracts.test.ts --reporter=dot` — 153 passed, 2
  platform-gated skips.
- `npm run verify:fast` — passed.
- `npm run verify:pr-prereqs` — passed.
- `npm run security:check` — passed.
- Canonical read-only intake decisions with
  `LIFECYCLE_MUTATION_OWNER=goobers` marked issues `#4270`–`#4273` eligible in
  the `approved` cohort; all remained open, unassigned, and unmodified.

## Apples

Actual: **3** — exact estimate; the code change is one canonical passthrough
entry, with the complexity in tracing materialization semantics and exercising
the live isolated-stage invocation contract.
