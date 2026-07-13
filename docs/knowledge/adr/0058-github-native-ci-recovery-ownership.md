# ADR 0058: GitHub-Native CI Recovery Ownership

## Status

Accepted

## Date

2026-07-11

## Estimated Complexity

🍎 x 5 — replaces multiple privileged CI automations and coordinates workflows, Copilot tasks, review threads, and shepherd ownership

## Context

- **CTX-001**: Crawler needs automatic recovery for merge conflicts, CI failures, workflow approvals, and actionable review threads.
- **CTX-002**: GitHub rejects Copilot coding-agent assignment from `GITHUB_TOKEN` and GitHub App installation tokens. Assignment requires the repository-scoped `CRAWLER_CI_PAT` user token.
- **CTX-003**: PAT-bearing jobs must use trusted default-branch workflow code, must never execute pull-request code, and must never expose the PAT to the Copilot checkout.
- **CTX-004**: Event storms and the 10-minute backstop must not create duplicate Copilot tasks for the same PR head and normalized blocker set.
- **CTX-005**: A human shepherd needs renewable exclusive ownership, with takeover allowed after 30 minutes without a heartbeat.
- **CTX-006**: Azure and all other external state services are prohibited dependencies for this CI recovery system.

## Decision

- **DEC-001**: Use an unprivileged event router to dispatch one trusted `workflow_dispatch` reconciliation run per PR.
- **DEC-002**: Serialize recovery and shepherd lease operations with the repository-wide concurrency group `crawler-ci-pr-N`, `queue: max`, and no `cancel-in-progress`.
- **DEC-003**: Use an atomically created temporary repository label `ci-owner-pr-N` as the ownership existence bit. Store full state in exactly one paginated sticky PR comment marked `<!-- crawler-ci-state:v1 -->`.
- **DEC-004**: Hash the latest head SHA and complete normalized blocker set. Never dispatch Copilot twice for the same fingerprint.
- **DEC-005**: Treat missing, duplicate, or inconsistent ownership state as an error that fails closed.
- **DEC-006**: Shepherds acquire, heartbeat, and release ownership only through the trusted workflow. Lease IDs are ownership identifiers, not secrets. A lease expires after 30 minutes plus a five-minute queue-jitter grace period.
- **DEC-007**: Give Copilot one consolidated task ordered as conflict/rebase, review feedback, CI failures, validation, and thread resolution.
- **DEC-008**: Require a different-model validator for listed review threads. Automatically resolve only marker-confirmed fixes or deterministic non-applicability; substantive disagreement remains unresolved and escalates.
- **DEC-009**: Never call GitHub's workflow-approval endpoint. That endpoint applies only to fork-PR workflow runs; CI recovery already rejects fork PRs at ingress. Same-repository required-check runs (`ci`, `commit-lint`) that are parked in `action_required` are escalated as `ci-retrigger` blockers instead — the operator or Copilot must push one commit under a different App or human identity to retrigger them. Non-required infrastructure runs (e.g. CI Recovery Router) that land in `action_required` are logged and skipped.
- **DEC-010**: Arm squash auto-merge only for the latest head when checks are green, mergeability is clean, all review threads are resolved, and no lease, escalation, or active task remains.
- **DEC-011**: Default rollout to `dry-run`; repository variable `CI_RECOVERY_MODE=live` is required for privileged mutations.

## Consequences

### Positive

- **POS-001**: All privileged decisions use auditable GitHub-native state and trusted code.
- **POS-002**: Per-PR FIFO serialization prevents lost reconciliation events and cross-PR blocking.
- **POS-003**: Fingerprints and atomic ownership prevent duplicate Copilot dispatches.
- **POS-004**: Shepherds and automation share one explicit ownership protocol instead of racing.
- **POS-005**: The system has no Azure or third-party runtime dependency.

### Negative

- **NEG-001**: Dynamic labels and sticky comments are more operationally visible than an external lock service.
- **NEG-002**: A crash between multi-step label/comment mutations can produce inconsistent state that requires manual repair.
- **NEG-003**: GitHub Actions `queue: max` allows up to 100 pending runs, so severe event storms can consume queue capacity.
- **NEG-004**: Different-model review validation is enforced by Copilot instructions and evidence, not by a deterministic CI model call.

### Risks

- **RSK-001**: GitHub API or Copilot assignment behavior may change; assignment is verified after mutation and failures escalate.
- **RSK-002**: Incorrect PAT scope could prevent approvals, assignment, resolution, or auto-merge; dry-run and explicit live mode limit rollout risk.
- **RSK-003**: A malicious reviewer could write prompt-like text in a review comment. The task treats comment bodies as quoted blocker data and constrains work to exact thread IDs.

## Alternatives Considered

### Azure Blob Compare-and-Swap State

- **ALT-001**: **Description**: Store per-PR lock records in Azure Blob Storage using ETags for compare-and-swap ownership.
- **ALT-002**: **Rejection Reason**: The maintainer explicitly prohibited Azure and all Azure dependencies in CI.

### GitHub Comment State Without Atomic Ownership

- **ALT-003**: **Description**: Use a sticky comment or fixed label as the sole state record.
- **ALT-004**: **Rejection Reason**: Read-modify-write comments and fixed labels cannot atomically prevent two runs from acquiring the same PR.

### Keep Independent Legacy Fixers

- **ALT-005**: **Description**: Repair the Codex router, coverage ping, rebase issue filer, and review resolver independently.
- **ALT-006**: **Rejection Reason**: Independent automations have conflicting ownership, duplicate-dispatch risk, ineffective token identities, and no shared lease protocol.

### GitHub App Instead of a User PAT

- **ALT-007**: **Description**: Mint a GitHub App installation token for all privileged mutations.
- **ALT-008**: **Rejection Reason**: GitHub explicitly rejects coding-agent assignment from installation tokens, and cross-App review threads cannot be resolved by that identity.
