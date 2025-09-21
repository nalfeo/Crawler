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
- Orchestration-level coverage drives a retryable error through the controller
  build loop, proves later entries are never built, and locks post-build
  validation/status failures outside the recovery boundary.
- Recovery now runs before publishing the failed entry's waiting status, so a
  reporting error cannot suppress promotion; the reporting error still surfaces.
- The full merge-train suite passes with 185 tests.

## Review harness

- Plan review: `claude-sonnet-4.6`, four concerns resolved. The review corrected
  the initial all-intermediate-prefixes-must-be-successful assumption to cumulative
  candidate semantics. `plan_divergence: minor`.
- Code review: the first cycle combined `gpt-5.4` with the GitHub Copilot review
  and different-model validation (`claude-sonnet-4.6` / `gpt-5.6-terra`). One
  valid orchestration-coverage concern was fixed. A second `gpt-5.3-codex` round
  incorporated a later GitHub review finding, validated with
  `gemini-3.1-pro-preview`, that moved recovery ahead of failure-status
  publication; the final implementation review was clean.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-20-fix-merge-train-promotion.review-ledger.json`.

## Boundaries

No GitHub App permissions, branch protection, required checks, workflow files,
unrelated PR state, or asset-pipeline surfaces were changed.
