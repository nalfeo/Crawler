# 2026-09-02 Goobers shadow thread recovery

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## What changed

- Replaced live-state reconstruction with immutable lifecycle decision records
  captured by each legacy CI Recovery and Merge Train run.
- Bounded daily collection to the resolved UTC report day and correlated records
  through their exact workflow run, PR, and head SHA.
- Ran the captured lifecycle inputs through a capability-empty Goobers workflow
  and compared its emitted decisions with the persisted legacy outcomes.
- Reused CI Recovery's authoritative marker resolver and paginated review reader,
  and made divergence artifact upload unconditional.

## Verification

- `npx vitest run tests/unit/goobers-shadow.test.ts`
- `node .github/scripts/validate-goobers-contracts.mjs`
- `/tmp/goobers-scaffold/goobers validate --source-tree .goobers`
- `bash scripts/agent/verify-fast.sh`

## Apples

Estimated 3, actual 3 — exact: the recovery required immutable legacy
instrumentation, a real read-only Goobers execution path, and workflow regression
coverage across the CI Recovery and Merge Train lanes.
