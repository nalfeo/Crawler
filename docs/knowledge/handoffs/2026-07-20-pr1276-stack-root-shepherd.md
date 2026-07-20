# Handoff: PR #1276 Stack-Root Shepherd

## Date

2026-07-20

## Persona

Producer / PR Shepherd

## Systems touched

ci-policy, docs-tooling, inventory

## Apples

3 apples estimated, 3 apples actual. The implementation contract had already
landed through PR #1280, but preserving the live downstream stack required a
history-safe conflict resolution, merge-train promotion, and post-merge source
ref restoration.

## Scope

PR #1276 is the base branch for open PRs #1379, #1305, and #1353. The shepherd
was explicitly authorized to land this non-asset PR while preserving the
placeholder gameplay strategy and avoiding all sprite, asset-label, queue,
workflow, Azure, and asset-PR mutations.

## Resolution

- Acquired the repository-managed CI Recovery shepherd lease before touching
  the branch.
- Confirmed PR #1280 had already landed the reviewed Floor 2 generated-equipment
  contract payload on `main`.
- Rejected the stale conflicted branch tree because it would have regressed
  newer specifications, epic state, and tooling now present on `main`.
- Merged current `main` into the stack-root history so all downstream branches
  retain ancestry, while making the merge result tree exactly equal to current
  `main` before adding this reconciliation record.
- Kept source-ref restoration as the first post-merge action: recreate
  `refs/heads/nalfeo-floor-2-equipment-contracts` at the final PR head after the
  squash merge auto-deletes it.

## Review

A separate-model plan review identified that native GitHub auto-merge and the
repository-managed merge train are distinct promotion mechanisms. The plan was
corrected to use CI Recovery admission plus the live merge train exclusively,
avoiding a race with ordinary auto-merge. Plan divergence was `major_fork`; all
five concerns were addressed through merge-path correction, explicit final-head
capture, immediate ref restoration, and lease heartbeats.

## Validation

- Repository preflight passed before conflict resolution.
- The pre-commit merge tree was compared directly with `origin/main`; only this
  handoff and its generated apple metric are permitted as net new files.
- PR review threads were empty before the resolution.
- Final local and GitHub validation is recorded in the parent coordination
  session together with the final PR head, non-null squash merge commit, and
  restored remote source ref.
