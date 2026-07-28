# ADR 0075: Scope CI conflict coordination and synchronize authoring branches

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 3 — tooling-only change spanning CI coordination and agent authoring policy

## Context

- **CTX-001**: The CI conflict coordinator treated every file under
  `.github/scripts/`, `.github/actions/`, and `scripts/agent/` as coordination
  input. Persisted coordinator state could also keep ordinary gameplay or
  content PRs coordinated after they no longer touched an eligible path.
- **CTX-002**: Coordination was created to serialize changes to CI workflow
  definitions and their dedicated `ci-*` implementation directories, not to
  become a general-purpose merge-conflict owner.
- **CTX-003**: Authoring branches often reached publication without explicit
  synchronization with `main`, shifting avoidable conflicts into CI Recovery
  and the Merge Train.
- **CTX-004**: Synchronization must not push intermediate commits, strand a
  branch in a conflicted rebase, or make missing evidence an independent PR
  blocker.

## Decision

- **DEC-001**: A PR is eligible for CI conflict coordination only when it changes
  `.github/workflows/**` or a descendant of a directory under
  `.github/scripts/` whose name starts with `ci-`.
- **DEC-002**: Persisted coordination groups are hydrated only with currently
  open members that still change an eligible path. Every coordinator label is
  removed from managed PRs absent from the resulting groups; historical
  comments remain audit records but cannot preserve out-of-scope membership.
- **DEC-003**: `scripts/agent/sync-main.mjs` fetches `origin/main` and rebases a
  clean, non-main authoring branch locally. Conflicting rebases are immediately
  aborted. Dirty or otherwise unsafe branches receive an actionable warning.
  The helper never pushes and records session-local evidence under `files/`.
- **DEC-004**: Synchronization runs at session preflight, after 30 measured
  active authoring minutes, and immediately before publication. Active time is
  accumulated only across bounded gaps between agent tool calls so idle time
  does not create a false cadence violation.
- **DEC-005**: Synchronization failures and missing evidence are soft warnings.
  Existing independent PR preflight failures remain hard denials. A
  pre-publication rebase warns that validation must be rerun on the new HEAD.

## Consequences

### Positive

- **POS-001**: Gameplay, content, agent-tooling, and unrelated GitHub automation
  PRs no longer enter CI conflict coordination.
- **POS-002**: Stale labels are deterministically removed instead of being
  revived by historical state.
- **POS-003**: Agents encounter upstream changes during authoring, before CI
  Recovery or Merge Train promotion.
- **POS-004**: Local-only rebases avoid triggering GitHub automation until the
  branch is intentionally published.

### Negative

- **NEG-001**: Agent tool calls write a small ignored activity-evidence file.
- **NEG-002**: Dirty worktrees cannot be safely rebased automatically; agents
  must checkpoint work before satisfying an overdue synchronization.
- **NEG-003**: A successful rebase can invalidate earlier validation and require
  targeted checks to run again.

### Risks

- **RSK-001**: A CI-adjacent script outside a `ci-*` directory will not receive
  coordinator protection and must rely on normal Git conflict handling.
- **RSK-002**: Agents that bypass the guard extension retain policy guidance and
  pre-publication self-healing but lose automatic active-time reminders.

## Alternatives Considered

### Coordinate every automation path

- **ALT-001**: **Description**: Keep `.github/actions/**`,
  `.github/scripts/**`, and `scripts/agent/**` in the coordinator scope.
- **ALT-002**: **Rejection Reason**: The broad scope creates ownership and queue
  state for PRs that normal Git synchronization can handle.

### Run a background synchronization daemon

- **ALT-003**: **Description**: Start a per-session timer that rebases every 30
  wall-clock minutes.
- **ALT-004**: **Rejection Reason**: A daemon survives idle periods, complicates
  process ownership, and can mutate a branch when no agent is actively
  authoring.

### Block publication without fresh evidence

- **ALT-005**: **Description**: Deny PR creation when synchronization evidence is
  missing, stale, or unsuccessful.
- **ALT-006**: **Rejection Reason**: Evidence and network failures are not proof
  that a branch is unsafe; blocking would turn a preventive mechanism into a
  new infrastructure deadlock.
