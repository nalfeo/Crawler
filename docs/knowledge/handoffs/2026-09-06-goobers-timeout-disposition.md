# Goobers timeout disposition guard

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## Production evidence

GitHub Actions run `34000153009` processed issue #4273 in Goobers run
`e9bf8438976d7839850db0f2a0e59acd`. Implement attempt 1 timed out after 30
minutes with `executor_error` / `errorClass=timeout` after recording a
139,854-byte `implement/unpushed-diff.patch` across 39 issue-scope files.
Attempt 2 reused the pinned runtime's dirty retry worktree, interpreted that
unfinished diff as already-completed work, and returned
`completed-existing-work`; `run.finished` then reported `completed`.

There was no closing or open implementation PR and no independent completion.
The false terminal label was removed operationally before this change, leaving
the still-open approved issue eligible for retry.

## What changed

- `Handle no-work disposition` now rejects `completed-existing-work` whenever
  the same run journal contains either an error/failed stage attempt or a
  positive-size `implement/unpushed-diff.patch` artifact record.
- The fail-closed branch never adds
  `goobers/status:completed-existing-work`. It removes only
  `goobers/status:in-review`, preserving `goobers:approved` and restoring
  scheduled retry eligibility after the existing provider-claim release
  barrier succeeds.
- The workflow warning names the journal evidence, uploaded artifact, and
  issue-scoped `gh workflow run goobers-run.yml` retry command.
- An executable cleanup regression reproduces the exact timeout, unpushed diff,
  dirty-worktree retry, no-work scalar disposition, and completed terminal
  phase. A structural assertion keeps the journal guard ordered before the
  terminal-label mutation.

## Runtime boundary

The pinned upstream Goobers runtime currently retries in the same dirty
worktree, which enabled attempt 2 to misclassify attempt 1's unfinished diff.
An upstream runtime may later reset retry worktrees, but this repository-side
journal guard remains necessary: terminal issue classification must not trust a
scalar disposition that contradicts durable failure or unpushed-work evidence.
No lifecycle ownership variables were changed here.

## Validation

- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run --project unit tests/unit/goobers-run-slot-cleanup.test.ts tests/unit/goobers-run-workflow.test.ts --reporter=dot`
- `npm run test:guards`
- `npm run verify:fast`

## Apples

Estimated **3**, actual **3**. The change remained within one workflow cleanup
branch and its deterministic executable/structural regression coverage.
