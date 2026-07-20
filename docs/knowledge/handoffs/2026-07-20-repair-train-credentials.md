# Merge-train workflow candidate credential repair

## Date

2026-07-20

## Persona

DevOps Engineer.

## Systems touched

ci-policy

## Apples

3 apples estimated, 3 apples actual. The estimate was exact: this was a
security-sensitive controller credential change with workflow wiring, deterministic
coverage, and a two-round review loop.

## Incident and root cause

PR #1694 is the FIFO leader and includes `.github/workflows/ci.yml`. Candidate
pushes in runs `29721471552` and `29721756406` failed because the repository
GitHub App token cannot create or update a ref containing workflow changes without
GitHub's workflow-write permission.

`actions/checkout` persists the App credential as an `http.extraheader`. Adding a
second authorization header is insufficient because Git treats that setting as
multi-valued. The controller therefore needs an explicit header reset before
authorizing the narrowly scoped candidate push with the existing owner token.

## What changed

- Candidate construction detects workflow-file changes across every commit in
  `baseSha..candidateSha`, including an edit followed by a later queued revert.
- Ordinary candidate pushes remain on the existing checkout/App credential.
- Workflow-bearing live candidate pushes use `CRAWLER_CI_PAT`, exposed as
  `MERGE_TRAIN_WORKFLOW_TOKEN` only to the trusted reconcile step.
- The PAT is applied only to the candidate-ref Git child by process-local Git
  configuration: an empty `http.extraheader` resets the App authorization before
  the PAT authorization entry.
- Existing `GIT_CONFIG_*` entries are preserved and the controller appends its two
  entries after the existing index space.
- The raw token is removed from every Git child-process environment and never
  appears in arguments, remote URLs, status output, or errors.
- A missing token fails before candidate-ref mutation. An insufficient token remains
  a retryable candidate-build failure; validation and promotion do not proceed.
- The merge-train guide documents minimum token permissions and the protected
  bootstrap boundary.

## Safety invariants

- FIFO order and immutable candidate-SHA semantics are unchanged.
- Branch protection, admission checks, candidate validation, and promotion are not
  weakened or bypassed.
- No direct merge, queue reorder, admin bypass, or fallback credential is added.
- Required token permission is repository access plus `workflow` for a classic PAT,
  or Contents read/write plus Workflows read/write for a fine-grained PAT.

## Deterministic coverage

- Ordinary candidates keep the App credential path.
- Workflow-bearing candidates select the owner token.
- Missing workflow token fails before ref mutation.
- Secrets are absent from Git arguments, URLs, errors, status output, and inherited
  Git environments.
- Existing command-scoped Git configuration is preserved.
- Reverted workflow edits remain workflow-bearing because the full commit range is
  inspected.
- FIFO and immutable-ref behavior remains covered by the merge-train suite.
- Focused controller tests pass 45/45, the full merge-train script suite passes
  193/193, workflow tests pass 45 with 7 skipped, and `verify:fast` passes.

## Runtime observation

Before the repair, live Merge Train runs `29721471552` and `29721756406` rejected
the workflow-containing candidate ref. After the repair, deterministic controller
execution reaches the credential-selected candidate push while preserving
validation and promotion gates. Live after-observation is intentionally pending:
this repair changes `merge-train.yml`, so the currently deployed broken controller
cannot push the repair's own workflow-containing candidate.

## Review harness

- Plan review: `claude-sonnet-4.6`, six concerns resolved,
  `plan_divergence: minor`.
- Code review round 1 found two related Git-environment concerns; both were fixed.
- Code review round 2 was clean.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-20-repair-train-credentials.review-ledger.json`.

## Protected rollout blocker

No repository-provided self-bootstrap path was found that preserves current
protection. The repair PR must remain behind #1694 in FIFO and cannot activate until
a human authorizes one of the existing protected bootstrap mechanisms. The minimum
direct administrative action is to grant the installed GitHub App temporary
Workflows read/write permission, let this repair land through the normal protected
train path, then restore the intended PAT-only boundary. If that permission change
is unavailable, a separately authorized documented emergency lane is required.

After activation on `main`, wake Merge Train and verify a new #1694 candidate ref
proceeds through normal validation and promotion before declaring the incident
resolved.
