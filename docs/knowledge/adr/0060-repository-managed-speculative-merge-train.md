# ADR 0060: Repository-Managed Speculative Merge Train

## Status

Accepted

## Date

2026-07-11

## Estimated Complexity

🍎 x 4 — privileged workflow orchestration, exact-commit validation, CI recovery integration, and branch-protection policy

## Context

- **CTX-001**: Crawler repeatedly rebases and retests every open PR after `main`
  advances, wasting CI and review cycles.
- **CTX-002**: GitHub's native merge queue is unavailable to this repository.
- **CTX-003**: No change may reach `main` unless the exact final commit has passed
  the required deterministic CI suite against the latest `main`.
- **CTX-004**: The existing workflow assumes GitHub-recorded PR merges, squash
  commit subjects derived from PR titles, resolved review threads, and linear
  history.
- **CTX-005**: Candidate code is untrusted. A token able to update `main` must
  never be available to a job that executes candidate code.

## Decision

- **DEC-001**: Replace broad eager rebasing with a repository-managed,
  oldest-PR-first train containing at most two cumulative candidates.
- **DEC-002**: Admit only ready, same-repository PRs carrying `merge-train` whose
  configured PR checks have passed and whose review threads are resolved.
- **DEC-003**: Construct immutable candidates as deterministic squash commits.
  Candidate one is `main+A`; candidate two is `main+A+B`.
- **DEC-004**: Validate candidates through trusted default-branch
  `workflow_dispatch` code. Candidate-executing jobs receive read-only repository
  permission. A separate job that never checks out candidate code publishes the
  `merge-train` check on the immutable candidate SHA.
- **DEC-005**: Promote only the train head, only when `main` still equals the
  candidate's recorded parent and the PR head, title, checks, and review state
  remain current.
- **DEC-006**: Promotion first force-updates the same-repository PR branch with an
  exact-head lease, then fast-forwards `main` to that same tested SHA. Because the
  PR head becomes reachable from `main`, GitHub retains merged-PR semantics while
  the shipped SHA remains exactly the tested candidate.
- **DEC-007**: CI recovery enqueues converged PRs instead of arming squash
  auto-merge when `MERGE_TRAIN_MODE=live`. Auto-rebase excludes queued PRs.
- **DEC-008**: Serialize all train mutation under `crawler-merge-train` with
  `queue: max`. Default the train to `off`; support `dry-run` before `live`.
- **DEC-009**: Require the `merge-train` check in branch protection so manual or
  legacy merge paths cannot bypass candidate validation. The repository App is
  the only actor allowed to bypass protection for the exact fast-forward.

## Consequences

### Positive

- **POS-001**: Every shipped SHA is the exact SHA validated against its parent on
  `main`.
- **POS-002**: The second candidate validates speculatively, reducing latency
  without rebasing all open PRs.
- **POS-003**: Each PR still contributes one final commit and remains recorded as
  merged by GitHub.
- **POS-004**: Privileged orchestration never executes candidate code.

### Negative

- **NEG-001**: Promotion force-rewrites the PR branch once, making old inline
  review locations outdated after admission.
- **NEG-002**: Candidate validation deliberately duplicates some PR CI to prove
  the cumulative commit.
- **NEG-003**: Fork PRs cannot enter this train because their head branch cannot
  be safely rewritten.
- **NEG-004**: Live rollout requires branch-protection and GitHub App bypass
  configuration outside the repository.

### Risks

- **RSK-001**: A failure between updating the PR head and fast-forwarding `main`
  leaves a tested candidate at the PR head. The next serialized reconciliation
  can retry; no untested commit reaches `main`.
- **RSK-002**: If required PR checks change but
  `MERGE_TRAIN_ADMISSION_CHECKS` does not, admission may wait incorrectly.
  Candidate validation still runs the canonical full verify, headless, e2e, and
  security suites.
- **RSK-003**: Incorrect App bypass configuration causes promotion to fail
  closed after validation.

## Alternatives Considered

### Native GitHub Merge Queue

- **ALT-001**: **Description**: Enable GitHub's managed merge queue.
- **ALT-002**: **Rejection Reason**: The feature is unavailable to this
  repository.

### Single-Candidate FIFO

- **ALT-003**: **Description**: Validate only `main+A`.
- **ALT-004**: **Rejection Reason**: It is simpler but gives up the approved
  shortest-merge-latency objective while the second PR could validate safely in
  parallel.

### Staging Pull Request

- **ALT-005**: **Description**: Merge queued changes through a bot-owned staging
  PR.
- **ALT-006**: **Rejection Reason**: GitHub's final merge operation creates a
  different commit, violating exact-SHA validation, or loses individual PR merge
  semantics.

### Third-Party Queue

- **ALT-007**: **Description**: Adopt Mergify, Graphite, or a Bors-style service.
- **ALT-008**: **Rejection Reason**: It adds external permissions, cost, and
  state dependency for behavior achievable with the existing GitHub App and
  Actions infrastructure.
