# Session Handoff: Unified CI Recovery

## Date

2026-07-11

## Persona

Producer → DevOps Engineer

## Systems touched

ci-policy, agent-personas

## Apples

5🍎 exact

## What Was Done

- Added a GitHub-native CI recovery router with PR/review/CI event triggers and a
  10-minute scheduled backstop.
- Added a trusted default-branch reconciler that uses `CRAWLER_CI_PAT` for
  Copilot assignment, same-repository workflow approval, marker-confirmed review
  resolution, and guarded squash auto-merge.
- Added atomic per-PR ownership using `queue: max`, dynamic repository labels,
  sticky state comments, exact head/blocker fingerprints, and renewable
  shepherd leases.
- Added deduplicated repository incident routing and migrated nightly mutation
  assignment to the verified PAT-backed GraphQL path.
- Retired the nonfunctional Codex/Azure repair runner, coverage-gap ping,
  standalone thread resolver, and their active docs/scripts.
- Updated the PR shepherd skill, agent, CI policy, repository instructions, ADR,
  rollout guide, and five-apple review ledger.
- Observed in the deterministic recovery artifact (`node --test
".github/scripts/ci-recovery/*.test.mjs"`): before, there was no shared state
  model; after, 12 tests cover fingerprint deduplication, lease expiry, sticky
  state round trips, check reruns, thread follow-ups/current-head markers, and
  PR/repository incident separation.

## Key Decisions Made

- The PAT is available only to workflows that execute trusted default-branch
  code and never execute PR code.
- Azure and all third-party state services are excluded from CI recovery.
- The dynamic repository label definition is the atomic ownership bit; the PR
  label is visibility and the sticky comment holds full state.
- Identical head/blocker fingerprints are never dispatched twice. Only changed
  blocker state can produce another Copilot task.
- Review disagreement cannot be auto-resolved. A different-model validator must
  provide evidence, and substantive disagreement remains open for escalation.
- Live mutation is gated by `CI_RECOVERY_MODE=live`; the default is dry-run.

## What's Next / Blockers

- Merge this branch, then inspect one event-driven dry-run and one scheduled
  dry-run from the trusted default-branch workflows.
- Run the disposable-PR mutation matrix in `docs/guides/ci-recovery.md`, then set
  `CI_RECOVERY_MODE=live`.
- After the live smoke is clean, disable the deleted workflow registrations
  listed in the rollout guide. They cannot be safely disabled before the
  replacement is present on `main`.
- No live GitHub mutation was attempted from this feature branch; that is an
  intentional rollout boundary, not an unverified claim of live behavior.

## Retrospective

### Lessons Learned

- GitHub Actions now supports `concurrency.queue: max`; it is the required FIFO
  behavior because default concurrency replaces an existing pending run.
- Copilot assignment and cross-App thread resolution need a user PAT; App
  installation tokens cannot provide the required identity.
- Exact deduplication requires stable logical check identities and the complete
  current review-thread comment state, not transient check-run IDs or root
  comments alone.

### Mistakes Made

- The first implementation fingerprinted check-run IDs and only the review
  thread root, so reruns and follow-up feedback could respectively create false
  changes and missed changes. Multi-model review caught both before rollout.
- The first incident workflow included PR-triggered security runs, which could
  contaminate repository-wide incident state. The final router rejects any run
  with a PR event or PR association before reading or mutating issues.
- The converged path initially wrote an intermediate idle state with stale
  blockers before the final clean state. It now performs one final state write.

### Opportunities for Future Improvement

- Add a mocked GitHub API integration harness for full reconcile transactions,
  including injected failures between label and comment mutations.
- Add an operator-only repair command for intentionally clearing inconsistent
  fail-closed ownership state after a partial GitHub API outage.
- Once live behavior is proven, capture dispatch/skip/escalation metrics in the
  scheduled workflow summary without introducing an external state dependency.
