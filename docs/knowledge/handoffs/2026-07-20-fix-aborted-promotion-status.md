# Preserve queue position after aborted promotion

## Date

2026-07-20

## Persona

DevOps Engineer, collaborating with Systems Engineer on recovery-state semantics.

## Systems touched

ci-policy

## Apples

3 apples estimated, 3 apples actual. The estimate was exact: this was a focused
controller-status correction with deterministic regression coverage and a required
review-harness cycle.

## What changed

- Added `queuePositionAfterRecovery` as the shared queue-position calculation for
  retryable merge-train build failures.
- The validated prefix is subtracted only when recovery explicitly reports
  `promoted === true` with a valid integer prefix length.
- If promotion was attempted but aborted because the existing hardened promotion
  path returned `false`, the failed entry keeps its original one-based queue
  position when no PR landed.
- Partial promotion reports the independently proven landed count, so status moves
  only by PRs that actually left the queue rather than by the full validated
  prefix.

## Root cause and scope

PR #1709's squash included validated-prefix recovery, but a push/merge race omitted
the follow-up correction from commit `7c47f0f7312abae2c14c388ea97d93b4d3c4b72f`.
The status path previously subtracted `greenPrefixLength` even when promotion did
not complete. The follow-up review also identified that a `false` result can follow
a partial batch, so recovery now distinguishes zero-land aborts from proven partial
progress. This follow-up recreates the missed behavior on current `main` without
altering promotion eligibility, main-health checks, stale-state checks, permissions,
workflows, assets, or unrelated pull requests.

## Deterministic coverage

- Successful validated-prefix promotion still moves the failed entry from position
  2 to position 1.
- An attempted promotion returning `false` reports `promotionAttempted: true` and
  `promoted: false`; with zero landed PRs, the failed entry remains at position 2.
- If one PR lands from a two-PR validated prefix before promotion returns `false`,
  the failed entry moves from position 3 to position 2.

## Verification

- `node --test .github/scripts/merge-train/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-20-fix-aborted-promotion-status.review-ledger.json`
- `npm run verify:pr-prereqs`

## Review harness

- Plan review: `gpt-5.4`, three concerns resolved with
  `plan_divergence: minor`.
- Code review: the first round combined `claude-sonnet-4.6` with GitHub Copilot
  review. One partial-promotion lifecycle concern was independently validated with
  `gpt-5.5` and fixed before the clean second round.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-20-fix-aborted-promotion-status.review-ledger.json`.
