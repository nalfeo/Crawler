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
  oldest-PR-first train containing up to six ready PRs.
- **DEC-002**: Admit only ready, same-repository PRs carrying `merge-train` whose
  configured PR checks have passed and whose review threads are resolved.
- **DEC-003**: Construct one immutable combined candidate as deterministic squash
  commits. Reconstruct every prefix SHA on reconciliation rather than trusting a
  pre-existing candidate ref.
- **DEC-004**: Validate candidates through trusted default-branch
  `workflow_dispatch` code. Candidate-executing jobs receive read-only repository
  permission. A separate job that never checks out candidate code publishes the
  `merge-train-candidate` result on the immutable candidate SHA.
- **DEC-005**: Promote only a validated combined candidate, only when `main`
  still equals its recorded parent and every included PR head, title, check, and
  review state remains current.
- **DEC-006**: Promotion atomically force-updates every same-repository PR branch
  and `main` directly to the final tested SHA, all under exact leases. No
  unvalidated intermediate SHA becomes a PR head or `main`; the validated
  candidate still contains one commit per PR and GitHub retains individual
  merged-PR semantics.
- **DEC-007**: `MERGE_TRAIN_ENABLED` is the sole rollout switch. When true, CI
  recovery works at most six oldest non-ready PRs, enqueues converged immutable
  heads instead of arming auto-merge, and rebases only PRs returned with textual
  conflicts. When false, legacy auto-merge and blanket rebase behavior remains.
- **DEC-008**: Serialize all train mutation under `crawler-merge-train` with
  `queue: max`. The switch accepts only `true` or `false`; there is no dry-run
  state.
- **DEC-009**: Require the `merge-train` check in branch protection so manual or
  legacy merge paths cannot bypass candidate validation. The repository App is
  the only actor that writes this required context, immediately before the exact
  fast-forward. Manually dispatched validators can write only the non-required
  `merge-train-candidate` result.
- **DEC-010**: Bind readiness to the PR head SHA plus an admission fingerprint of
  required checks and review threads. Movement of `main` alone does not expire
  this evidence.
- **DEC-011**: Run `verify:fast` plus the targeted security suite once on the
  combined candidate. On failure, binary-search ordered prefixes, promote the
  maximal green prefix, and return the first failing addition to recovery. Run
  the broad functional suite hourly on `main`.

## Consequences

### Positive

- **POS-001**: Every shipped SHA is the exact SHA validated against its parent on
  `main`.
- **POS-002**: Up to six PRs validate together without rebasing unchanged heads.
- **POS-003**: Each PR still contributes one final commit and remains recorded as
  merged by GitHub.
- **POS-004**: Privileged orchestration never executes candidate code.

### Negative

- **NEG-001**: Promotion force-rewrites the PR branch once, making old inline
  review locations outdated after admission.
- **NEG-002**: Cross-PR regressions outside `verify:fast` and the targeted
  security suite may remain on `main` until the hourly health run detects them.
- **NEG-003**: Fork PRs cannot enter this train because their head branch cannot
  be safely rewritten.
- **NEG-004**: Live rollout requires branch-protection and GitHub App bypass
  configuration outside the repository.

### Risks

- **RSK-001**: Git hosting must support atomic multi-ref pushes. If either the PR
  head lease or `main` lease fails, neither ref moves and reconciliation rebuilds
  from current state.
- **RSK-002**: If required PR checks change but
  `MERGE_TRAIN_ADMISSION_CHECKS` does not, admission may wait incorrectly.
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
