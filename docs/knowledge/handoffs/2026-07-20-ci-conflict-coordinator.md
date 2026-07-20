# Handoff: CI conflict coordinator

## Date

2026-07-20

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact — one deterministic coordinator subsystem, trusted workflow wiring, and focused regression coverage).

## Summary

- Added a trusted repository-wide coordinator for transitive clusters of three or more open PRs that overlap CI-owned paths under `.github/actions/**`, `.github/scripts/**`, `.github/workflows/**`, or `scripts/agent/**`.
- Ranks one canonical leader and explicit order deterministically: required-check green first, then CI/file completeness, then oldest PR and PR number.
- Proves safe duplicate closure by synthetic-squashing each complete PR diff onto current `main` plus ordered predecessors. A PR closes only when its full squash is a no-op and the bound `main`, leader, predecessor, and target heads all still match immediately before closure.
- Keeps conflicts, missing proof, ownership inconsistencies, and active non-current owners open with a managed escalation comment/label.
- Fences all members before exposing one merge slot, disables direct auto-merge for non-current members, and dispatches the existing `ci-recovery.yml` only for the active slot. Merge train now excludes the coordinator wait label.
- Preserves CI-recovery ownership semantics: healthy leases suppress duplicate dispatch/closure, expired shepherd leases release before the order fence, and human-approval-blocked PRs continue ordinary recovery tracking.
- Runs on PR lifecycle events and CI completion, with a five-minute scheduled backstop and one global concurrency group.

## Files changed

- `.github/scripts/ci-conflict-coordinator/state.mjs`
- `.github/scripts/ci-conflict-coordinator/proof.mjs`
- `.github/scripts/ci-conflict-coordinator/reconcile.mjs`
- `.github/scripts/ci-conflict-coordinator/state.test.mjs`
- `.github/workflows/ci-conflict-coordinator.yml`
- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/merge-train/state.mjs`
- `package.json`
- `docs/knowledge/review-ledgers/2026-07-20-ci-conflict-coordinator.review-ledger.json`

## Deterministic evidence

- Threshold coverage distinguishes two overlapping PRs from the required three.
- Transitive coverage links PR A↔B and B↔C even when A and C share no file directly.
- A temporary git repository proves the full-tree sequence classifies an exact duplicate as superseded, preserves a unique change, and escalates a conflicting change.
- State/comment round-tripping proves semantic idempotency.
- Workflow/source wiring tests lock the PR event set, five-minute fallback, single concurrency group, merge-train wait exclusion, expired-lease ordering, and human-approval exemption.

## Verification

- `node --test .github/scripts/ci-conflict-coordinator/state.test.mjs .github/scripts/merge-train/state.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run scope` (Windows/WSL path detection failed safe to all-false; no discretionary heavy checks were needed)
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-20-ci-conflict-coordinator.review-ledger.json`

## Review harness

- Plan review (`gpt-5.4`): approved with four resolved safeguards; `plan_divergence=minor`.
- Code review round 1 (`claude-sonnet-4.6`): two valid ownership-lifecycle findings, both fixed.
- Code review round 2 (`claude-sonnet-4.6`): clean after syncing the worktree to current `main`; the reported missing guard tests were confirmed to exist on current `main`.

## Unresolved issues

None.
