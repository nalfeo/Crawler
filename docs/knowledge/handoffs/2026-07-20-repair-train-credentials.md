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

The initial PAT design was unsafe because a branch push would emit a trusted
`push` event, allowing queued workflow code to run with repository secrets before
candidate validation. The recursion-suppressed `GITHUB_TOKEN` design was also
non-viable because GitHub blocks it from creating a branch containing workflow
changes. Candidate transport therefore moved out of branch and tag namespaces
entirely.

## What changed

- Every candidate is packaged as a thin Git bundle, stored as an opaque blob, and
  pushed to an immutable custom ref under `refs/merge-train-candidates/**`.
- Custom refs do not emit branch/tag `push` or `create` events, so workflow-bearing
  candidate commits cannot execute before explicit SHA-bound validation. Because
  the ref points to a blob rather than the candidate commit, GitHub also does not
  evaluate bundled workflow paths during the App-authenticated ref update.
- Candidate pushes remain on the existing trusted checkout/App credential; no PAT
  or built-in `GITHUB_TOKEN` override is used.
- Live construction rejects any candidate destination outside the custom namespace
  before running a Git command.
- Read-only validation fetches the blob, verifies and imports the bundle, and
  checks the materialized commit against the dispatched candidate SHA before
  running candidate code. Checks attach to the trusted `main` commit with an
  external ID that binds the queue fingerprint and exact candidate SHA.
- The legacy workflow-token environment variable is removed from every Git child
  environment, and secrets never appear in arguments, remote URLs, status output,
  or errors.
- A denied custom-ref push remains a retryable candidate-build failure; validation
  and promotion do not proceed.
- The merge-train guide documents the custom-ref trust boundary and protected
  bootstrap blocker.

## Safety invariants

- FIFO order and immutable candidate-SHA semantics are unchanged.
- Branch protection, admission checks, candidate validation, and promotion are not
  weakened or bypassed.
- No direct merge, queue reorder, admin bypass, or fallback credential is added.
- Candidate transport cannot target a branch or tag namespace.

## Deterministic coverage

- Ordinary and workflow-bearing candidates use the same custom-ref/App path.
- Branch and tag destinations fail before any Git command.
- Transport creation uses a thin bundle, a blob object, and an immutable
  fingerprinted custom ref; validation rejects non-blob refs and SHA mismatches.
- Secrets are absent from Git arguments, URLs, errors, status output, and inherited
  Git environments.
- FIFO and immutable-ref behavior remains covered by the merge-train suite.
- Focused merge-train, workflow contract, and fast verification results are recorded
  in the implementation session.

## Runtime observation

Before the repair, live Merge Train runs `29721471552` and `29721756406` rejected
the workflow-containing branch candidate. Deterministic controller coverage now
proves all candidates use non-event custom refs while preserving validation and
promotion gates. A disposable production-repository probe successfully pushed,
fetched, type-checked, and deleted a blob-only custom ref. Live candidate
after-observation remains pending until this repair is bootstrapped ahead of FIFO
leader #1694.

## Review harness

- Plan review: `claude-sonnet-4.6`, six concerns resolved,
  `plan_divergence: major_fork` after both branch-credential designs were
  invalidated and replaced by opaque bundle transport.
- Code review round 1 found two related Git-environment concerns; both were fixed.
- Final bundle-transport review found and fixed an argv credential exposure and
  stale workflow-contract assertions; the affected tests are clean.
- Post-publication review found the PAT-triggered workflow execution boundary and
  the built-in `GITHUB_TOKEN` workflow-write limitation. The final design uses
  non-event custom refs with no candidate credential override.
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
