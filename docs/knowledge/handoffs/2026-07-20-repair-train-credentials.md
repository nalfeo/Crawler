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
multi-valued. More importantly, a PAT-authenticated push would emit a trusted
`push` event: a queued PR could add a workflow matching `merge-train/**` and run
it with repository secrets before validation. Workflow-bearing candidate pushes
therefore require the recursion-suppressed `GITHUB_TOKEN`, never a PAT or App
token.

## What changed

- Candidate construction detects workflow-file changes across every commit in
  `baseSha..candidateSha`, including an edit followed by a later queued revert.
- Ordinary candidate pushes remain on the existing checkout/App credential.
- Workflow-bearing live candidate pushes use the workflow's `GITHUB_TOKEN` with
  `contents: write` and `workflows: write`; GitHub suppresses recursive workflow
  runs created by this credential.
- The token is applied only to the candidate-ref Git child by process-local Git
  configuration: an empty `http.extraheader` resets the App authorization before
  the `GITHUB_TOKEN` authorization entry.
- Existing `GIT_CONFIG_*` entries are preserved and the controller appends its two
  entries after the existing index space.
- The legacy workflow-token environment variable is removed from every Git child
  environment, and the selected token never appears in arguments, remote URLs,
  status output, or errors.
- A missing token fails before candidate-ref mutation. An insufficient token remains
  a retryable candidate-build failure; validation and promotion do not proceed.
- The merge-train guide documents the recursion-suppressed credential boundary and
  protected bootstrap blocker.

## Safety invariants

- FIFO order and immutable candidate-SHA semantics are unchanged.
- Branch protection, admission checks, candidate validation, and promotion are not
  weakened or bypassed.
- No direct merge, queue reorder, admin bypass, or fallback credential is added.
- PAT and App credentials are forbidden for workflow-bearing candidate pushes
  because they can trigger unvalidated candidate workflows.

## Deterministic coverage

- Ordinary candidates keep the App credential path.
- Workflow-bearing candidates select `GITHUB_TOKEN` regardless of any legacy PAT
  environment variable.
- Missing `GITHUB_TOKEN` fails before ref mutation.
- Secrets are absent from Git arguments, URLs, errors, status output, and inherited
  Git environments.
- Existing command-scoped Git configuration is preserved.
- Reverted workflow edits remain workflow-bearing because the full commit range is
  inspected.
- FIFO and immutable-ref behavior remains covered by the merge-train suite.
- The full merge-train script suite passes 195/195. Workflow tests and
  `verify:fast` pass.

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
- Post-publication review found the PAT-triggered workflow execution boundary.
  `claude-sonnet-4.6` and `gpt-5.6-luna` validated it; the repair now uses only
  recursion-suppressed `GITHUB_TOKEN` for workflow-bearing candidate pushes.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-20-repair-train-credentials.review-ledger.json`.

## Protected rollout blocker

No repository-provided self-bootstrap path was found that preserves current
protection. The repair PR must remain behind #1694 in FIFO and cannot activate until
a human explicitly authorizes the documented protected emergency lane. Temporarily
granting the installed GitHub App workflow-write permission is not safe: the App
push could trigger the same unvalidated candidate workflow that the final design
prevents.

After activation on `main`, wake Merge Train and verify a new #1694 candidate ref
proceeds through normal validation and promotion. Then normally re-admit #1706 and
verify its workflow-bearing candidate ref through the same path before declaring
the incident resolved.
