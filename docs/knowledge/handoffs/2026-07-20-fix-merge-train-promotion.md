# Merge-train validated-prefix promotion recovery

## Date

2026-07-20

## Persona

DevOps Engineer, collaborating with Systems Engineer on ordering semantics.

## Systems touched

ci-policy

## Apples

3 apples estimated, 3 apples actual. The estimate was exact: this was a focused
controller-ordering change with deterministic regression coverage and production-
critical review requirements.

## What changed

- Retryable candidate-build failures now stop construction without immediately
  exiting reconciliation.
- The controller finds the highest already-built cumulative candidate with
  terminal successful validation and promotes exactly that FIFO prefix through
  the existing hardened promotion path.
- Later built-but-unvalidated candidates and the failed/later queue entries remain
  queued for a future reconcile.
- Conflict and no-op candidate handling is unchanged.

## Root cause and safety

The controller built every queue prefix before entering promotion planning. A
retryable failure while pushing a later candidate branch therefore exited the run
before an earlier validated cumulative candidate could be promoted.

Recovery reuses `promotePrefix` and `promoteExactBatch`; it does not bypass main
health, candidate-evidence reattestation, PR admission, base CAS, ordered GitHub
squash merges, or landed-commit proof. Cumulative validation semantics matter:
if prefix 2 is successful, it proves PRs 1-2 even when prefix 1 was never
independently validated.

## Deterministic coverage

- A realistic `missing, success, pending` state followed by a later build failure
  promotes PRs 1-2 in order and leaves PRs 3-4 outside the promoted prefix.
- A failure before any successful cumulative candidate does not call promotion.
- A successful prefix followed by failed/pending candidates promotes only through
  the successful prefix.
- The full merge-train suite passes with 180 tests.

## Review harness

- Plan review: `claude-sonnet-4.6`, four concerns resolved. The review corrected
  the initial all-intermediate-prefixes-must-be-successful assumption to cumulative
  candidate semantics. `plan_divergence: minor`.
- Code review: `gpt-5.4`, one clean round with no significant issues.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-20-fix-merge-train-promotion.review-ledger.json`.

## Boundaries

No GitHub App permissions, branch protection, required checks, workflow files,
unrelated PR state, or asset-pipeline surfaces were changed.
