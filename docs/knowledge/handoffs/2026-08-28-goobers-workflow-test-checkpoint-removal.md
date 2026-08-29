# 2026-08-28 — Fix stale Goobers checkpoint-branch test assertion

## Summary

CI incident (issue #3863, run 33213338717) failed `Unit Tests` and `Advisory
coverage` because `tests/unit/goobers-run-workflow.test.ts` still asserted the
old `checkpoint-branch` task that a prior commit
(`d486a7388f0dbd9c25951a3cade320c1b9dd58b5`, "fix: remove broken Goobers
checkpoint stage") intentionally removed from
`.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml`. The workflow now
splits that combined stage into `push-branch` → `local-ci` → `local-gate` →
`open-pr`, gated by the `review` and `local-gate` gates, but the test wasn't
updated to match.

## Fix

Updated the "bounds same-run retries without retrying claim or provider
mutations" test to assert the current task graph:

- `implement.next` is `review` (not the removed `checkpoint-branch`).
- `review` gate branches: `pass -> push-branch`, `needs-changes -> implement`,
  `fail -> park-needs-human`, `escalate -> needs-remediation`.
- `push-branch.next` is `local-ci`; `local-ci` runs `npm run verify:fast` and
  its `next` is `local-gate`.
- `local-gate` branches: `pass -> open-pr`, `fail -> implement`,
  `infra -> local-ci`, `escalate -> needs-remediation`.
- `open-pr` runs the `['goobers', 'open-pr']` command.
- Replaced `checkpoint-branch` with `local-ci` in the no-retry task name list
  (the task no longer exists).

No production code changed — this is a test-only fix restoring parity between
the test and the already-shipped (and intentional) workflow-definition change.

## Files touched

- `tests/unit/goobers-run-workflow.test.ts`

## Verification run

- `npx vitest run tests/unit/goobers-run-workflow.test.ts` — 8 passed
- `npx vitest run tests/unit --project unit` — 439 files / 6085 tests passed
- `npx eslint tests/unit/goobers-run-workflow.test.ts` — clean
- `npm run verify:pr-prereqs` — passes aside from advisory handoff/ledger notes
  (this file resolves the handoff requirement; 1🍎 test-only fix needs no
  review ledger)

## Unresolved issues / next steps

None. This closes out CI incident issue #3863.

## Systems touched

ci-cd
