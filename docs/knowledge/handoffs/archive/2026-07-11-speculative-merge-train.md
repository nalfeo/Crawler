# Session Handoff: Two-Candidate Speculative Merge Train

## Date

2026-07-11

## Persona

Producer → DevOps Engineer

## Systems touched

ci-policy

## Apples

4🍎 estimated, 5🍎 actual (📉 under — exact-SHA promotion required additional trust-boundary and recovery work)

## What Was Done

- Added a repository-managed, oldest-admitted-first merge train with two
  cumulative candidates: `main+A` and `main+A+B`.
- Added deterministic candidate construction, fingerprints, sticky queue status,
  conflict isolation, stale-state checks, and atomic exact-lease promotion.
- Added a trusted validation workflow that runs full verify, headless, e2e, and
  security checks without exposing write credentials or shared caches to
  candidate code.
- Split the non-required `merge-train-candidate` result from the required
  `merge-train` promotion context, so manual workflow dispatch cannot bypass
  queue ordering.
- Integrated CI recovery and auto-rebase: clean PRs enter the train in live mode,
  and queued/blocked PRs are not rewritten by legacy automation.
- Added eight deterministic state tests, ADR 0060, operator rollout guidance, and
  four-apple review-harness evidence.
- Observed in the deterministic merge-train artifact (`node --test
".github/scripts/merge-train/*.test.mjs"`): before, no queue state model
  existed; after, eight tests cover admission order, fingerprints, immutable ref
  names, deterministic commit timestamps, latest-check selection, and status
  rendering. No live GitHub mutation was attempted from this feature branch;
  the documented dry-run and disposable-PR matrix is the required post-merge
  observation boundary.

## Key Decisions Made

- The exact tested candidate SHA, not merely an equivalent tree, must become the
  new `main`.
- Promotion atomically updates the PR head and `main`; GitHub therefore records
  the original PR as merged while preserving one final commit per PR.
- Privileged reconciliation checks out only trusted default-branch code.
  Candidate-executing jobs have read-only permissions and cannot save shared
  caches.
- Every reconcile reconstructs the expected candidate SHA. A predictable remote
  candidate ref and a manually dispatched validation result are never trusted as
  promotion authority.
- Candidate validation writes `merge-train-candidate`; only the repository App
  writes the branch-protection-required `merge-train` context immediately before
  atomic promotion.
- Native GitHub merge queue was preferred but unavailable; third-party queues
  were rejected to avoid new cost, permissions, and external state.

## What's Next / Blockers

- Merge with `MERGE_TRAIN_MODE` unset (`off`), then follow
  `docs/guides/merge-train.md`. _(deprecated no-op — repo variable deleted
  2026-07-22; not read by any workflow or script.)_
- Run dry-run mode with two manually labeled disposable PRs.
- Configure `merge-train` as required and grant only the repository App branch
  protection bypass before live mode.
- Execute the documented conflict, stale-head, failed-validation, race, and
  GitHub merged-PR/OID matrix before enabling automatic CI-recovery enrollment.
- Fork PRs remain intentionally unsupported by the train.

## Retrospective

### Lessons Learned

- A synthetic candidate branch alone does not preserve GitHub's merged-PR
  semantics. Atomically moving the original PR head and `main` to the tested SHA
  does.
- Candidate code must not invoke candidate-controlled local actions that write
  caches later consumed by privileged workflows.
- A required check that a manually dispatched validator can publish is not queue
  authority; validation and promotion contexts need separate names.
- The second cumulative commit can be reused without retesting after the first
  lands when commit metadata is deterministic.

### Mistakes Made

- The first implementation trusted an existing predictable candidate ref. The
  early warning was that promotion proved only the parent SHA, not candidate
  provenance; reconstruction now makes the local expected SHA authoritative.
- The first validator used the candidate's cached local setup action. The early
  warning was any candidate-executing job sharing cache keys with secret-bearing
  workflows; validation now uses uncached external setup and ignores lifecycle
  scripts.
- The initial CI-recovery patch matched the wrong `if (live)` block and queued
  before resolving review threads. The early warning was an insertion context
  too broad for a file with several identical guards; enqueue now lives only in
  the converged path.
- The first promotion used two pushes. The early warning was no recovery path
  between ref updates; one atomic, dual-lease push now prevents partial state.

### Opportunities for Future Improvement

- Add a mocked GitHub API/git integration harness for full candidate build,
  dispatch, and atomic promotion transactions.
- Automatically clean obsolete `merge-train/candidate-*` refs after a bounded
  retention period.
- Read required admission contexts from repository rulesets when GitHub exposes a
  stable API shape for all rule types, rather than maintaining the repository
  variable.
