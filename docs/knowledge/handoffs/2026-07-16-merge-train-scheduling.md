# Merge-train scheduling and validation

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3 apples estimated and actual - workflow scheduling, reconcile policy, deterministic
tests, and an amendment to the existing promotion ADR.

## What changed

- Changed `merge-train.yml` concurrency from workflow-level `queue: max` to
  job-level `queue: single`. Active reconciliation is never cancelled, only the
  latest pending admitted wake is retained, and rejected PR events never contend
  for that slot.
- Restricted `pull_request_target` reconcile jobs to same-repository PRs that
  currently carry or are transitioning the `merge-train` label. Label removal
  still wakes cleanup, and queued synchronize, edited, closed, and
  ready-for-review events remain admitted.
- Changed exact-SHA main health selection to use the newest completed
  authoritative full-CI run. A newer pending duplicate no longer hides an
  existing green result; a later completed failure still blocks, and pending-only
  or absent evidence remains fail-closed.
- Changed candidate planning to validate the maximal FIFO prefix first. A
  successful batch needs one candidate validation. Only a terminal maximal
  failure enters bisection; cancelled, stale, skipped, timed-out, dispatch, and
  publication outcomes remain retryable and redispatch the same candidate.
- Reattests the selected maximal or bisected candidate evidence before every
  sequential merge while retaining admission, main-health, base-CAS, and landed
  parent/tree postconditions.
- Updated the merge-train guide and added ADR 0063 DEC-012 to supersede the eager
  all-prefix validation policy. No CI-recovery files changed.

## Deterministic coverage

- Workflow tests assert `queue: single`, absence of active cancellation,
  same-repository trust, queued PR event preservation, label transition cleanup,
  and rejection of unrelated/fork wakes.
- Main-health tests cover green evidence plus a newer pending duplicate, a later
  completed failure, and fail-closed pending-only/absent evidence.
- Planner tests cover maximal-first dispatch, one-round maximal success,
  failure-only bisection, FIFO green-prefix promotion, pending bisection waits,
  and retryable maximal outcomes.
- Promotion tests cover live batch-evidence loss before the first and later
  sequential merges.

## Validation

- `node --test .github/scripts/merge-train/*.test.mjs` - 177 passed.
- `npx vitest run --project unit tests/unit/merge-train-workflow-wakeups.test.ts tests/unit/merge-train-validate-publish.test.ts tests/unit/merge-train-promotion-gate.test.ts`
  - 40 passed after the post-publish review tightened event-type coverage.
- `npm run verify:fast` - passed.

## Review harness

- Plan review: `claude-sonnet-4.6`, approved with refinements; all four concerns
  resolved or deterministically adjudicated, `plan_divergence: minor`.
- Code review round 1: `gpt-5.3-codex`, no significant issues.
- Post-publish review round 2: `claude-sonnet-4.6` validated and resolved two
  findings: trigger-type coverage now consumes the workflow subscription, and
  scheduled-CI wake comments match completed-only main-health authority.
- A subsequent PR review found the workflow-level concurrency race; independent
  `gemini-3.1-pro-preview` validation moved serialization behind the job gate and
  added a regression assertion that no workflow-level queue exists.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-16-merge-train-scheduling.review-ledger.json`.

## Remaining risk

Successful batches now rely on the maximal integrated candidate validation
instead of independently executing the candidate suite for each intermediate
prefix. Each PR still has admission CI/security evidence, and every sequential
merge retains exact landed-tree and repository-state proofs. DEC-012 records this
human-approved throughput trade-off.
