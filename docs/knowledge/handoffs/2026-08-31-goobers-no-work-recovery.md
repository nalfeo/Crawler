# Goobers no-work recovery

## Systems touched

agent-tooling, ci

## Apples

Estimated: 3🍎 — actual: 3🍎.

## Summary

- Prevented the Crawler implementer from treating passing pre-existing tests as
  proof that an open approved issue has no work.
- Directed the producer to reuse canonical repository sweep cohorts and derive
  deterministic bands for explicitly approximate targets rather than escalating
  those engineering details.
- Restored retry eligibility when a terminal Goobers journal contains a
  `no-work` stage and no existing PR is being resumed, with an actionable
  warning and retry command.
- Made issue diagnostics recover the claimed issue from the explicit recovery
  input or `query-backlog` output instead of requiring an issue `ref.touched`
  event that the journal does not emit.
- Moved concurrency to the eligible job so unrelated issue-label events cannot
  cancel a queued manual or scheduled run before the job condition skips them.

## Evidence

- Actions run `33402053759` claimed issue `#3798`, then its implementer returned
  `status: no-work` after only running existing XP/boss tests. The journal
  deleted the unpushed branch and completed successfully.
- The claim left `goobers/status:in-review` on `#3798`, so hourly recovery
  excluded it despite there being no Goobers PR.
- Manual run `33438906132` was cancelled while pending when unrelated
  issue-label run `33439146247` entered the workflow-level concurrency group.

## Verification

- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-contracts.test.ts`
- `npm run test:guards`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Operational recovery

Removed the stale `goobers/status:in-review` label, cleared the occupied Goobers
queue, and explicitly dispatched issue `#3798` in Actions run `33439537699`.
