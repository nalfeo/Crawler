# Handoff: PR #1287 conflict recovery

## Date

2026-07-19

## Persona

PR Shepherd / Systems Engineer

## Systems touched

ci-policy, docs-tooling, agent-personas

## Apples

Estimated 2 apples, actual 4 apples. The original merge-conflict estimate missed
the semantic integration and review work required after two overlapping protocol
implementations independently reached `main`. Full calibration:
`docs/knowledge/metrics/apples/2026-07-19-pr1287-conflict-recovery.json`.

## What changed

- Merged current `origin/main` into PR #1287 without rewriting branch history,
  preserving the ancestry required by downstream PR #1276.
- Reconciled main's narrower epic-control implementation with PR #1287's reviewed
  `crawler-epic-state/v2` speculative stacked-work protocol.
- Preserved main's AJV committed-schema validation, plan-contract drift
  suppression, superseded-node release behavior, fresh-claim semantics,
  same-owner lease reconciliation, `applyGithubAudit`, and silent workflow JSON
  output.
- Preserved the v2 dedicated stacked-owner namespace, exact prerequisite
  snapshots, one exact stack base, nullable dependent-head cache, resync
  freshness, explicit rebase-to-main proof, and read-only GitHub reconciliation.
- Removed the obsolete parallel `mode` / `stack_bases` /
  `requires_main_rebase` contract and rewrote the operator recovery runbook around
  the canonical v2 fields and diagnostics.
- Made stacked PR transition diagnostics edge-triggered by cached observation
  drift, suppressed ownership adjudication after failed issue audits, folded
  claims before expiry filtering, reconciled exact-owner timestamps, and extended
  committed-schema parity to every stacked PR identity contract.
- Made canonical GitHub PR URLs the sole persisted stacked PR identity and
  derived PR numbers at audit time, eliminating a cross-field invariant that
  standard JSON Schema cannot represent.
- Reconciled post-review live drift after A0 PR #1271 merged: advanced A0 to
  `merged`, recorded its authoritative head/merge facts, cleared inactive
  ownership, and recorded closed issue observations for A0 and A1. The test
  helper now reconstructs its pre-merge lifecycle fixture explicitly instead of
  depending on mutable committed state.
- Added deterministic regression coverage for all integrated behaviors. No asset
  workflow, queue, label, brief, sprite, or Azure mutation is part of the
  effective diff from `origin/main`.

## Observe before done

- Before: GitHub reported PR #1287 as conflicting after overlapping epic-control
  work merged to `main`; a local no-commit merge reproduced semantic conflicts
  across the implementation, schema, state, tests, plan, handoff, and review
  ledger.
- After: the merged tree has no unmerged entries or conflict markers, the v2
  manifest validates against both Zod and the committed JSON Schema, and the
  read-only offline audit reports no errors, warnings, proposals, or writes.

## Review and validation

- Four-apple adversarial plan review: six concerns resolved, two alternatives
  rejected, divergence `minor`.
- Single-model code review: two bounded rounds, all three concerns resolved.
- Multi-model review: four valid round-one concerns resolved; terminal review by
  Claude Opus 4.8, Gemini 3.1 Pro, and GPT-5.3 Codex security review adjudicated
  clean by GPT-5.4.
- Different-model validation covered all 27 GitHub review threads across two
  rounds. The final eight tightened owner chronology, live-claim selection,
  merged dependent handling, post-merge base constraints, stacked identity
  fields, canonical PR identity, and no-PR observation proof.
- Focused epic-status suite: 79 tests pass.
- Source typecheck passes.
- Offline and credentialed read-only GitHub audits are valid with zero errors,
  warnings, proposals, or operator actions and report `writes_performed=false`.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-19-pr1287-conflict-recovery.review-ledger.json`.

## Stacked PR preservation

PR #1276 remains outside this session's mutation scope. Immediately before
arming PR #1287, record the exact branch head; after the squash merge, restore
`refs/heads/nalfeo-floor-2-stacked-work-protocol` to that exact SHA if GitHub
auto-deletes it. PR #1276's cached prerequisite snapshots will then be stale by
design and must be resynced or rebased in its own later session.

## Unresolved issues

- None in the recovered implementation. Publication still requires the final
  committed-tree gates, one push, green GitHub checks and conversations, lease
  release, authorized auto-squash merge, bounded merge verification, and exact
  downstream branch-ref restoration.
