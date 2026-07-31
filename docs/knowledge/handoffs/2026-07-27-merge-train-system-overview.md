# Handoff: Merge-Train System Overview (Consolidated Reference)

## Date

2026-07-27

## Persona

DevOps Engineer / Producer

## Systems touched

ci-policy

## Apples

1🍎 (documentation consolidation; no code changes)

## Purpose

This document consolidates 7+ fragmented merge-train handoffs from July 14–22
into a single living reference. The individual session handoffs remain in place
for full detail; this document is the fast-access summary for the next agent
picking up merge-train work.

---

## Architecture Overview

The speculative merge train is implemented in `.github/scripts/merge-train/` and
dispatched via `.github/workflows/merge-train.yml`. The key scripts are:

| File | Role |
|------|------|
| `reconcile-lib.mjs` | Core logic: candidate construction, promotion (squash-merge), proof, landed signals |
| `reconcile.mjs` | Orchestrator: CI recovery admission, review gating, sequential reconcile loop |
| `state.mjs` | Shared constants: label names, marker strings, check names |
| `.github/workflows/merge-train.yml` | Dispatch target; concurrency is job-level `queue: single` |
| `.github/workflows/ci-recovery.yml` | Review/repair automation; dispatches `merge-train.yml` after admission |

---

## Key Design Decisions (from July 2026 handoffs)

### 1. Promotion = GitHub squash-merge, not force-push (2026-07-15)

The atomic multi-ref force-push was **replaced** with sequential
`POST /pulls/{n}/merge` (squash) per PR. Rationale:

- GitHub only sets `merged:true` / `merged_at` when a PR closes through its own
  merge machinery. Force-pushing the tree gave `state:closed, merged:false` — the
  maintainer's hard gate was never satisfiable.
- The merge API has no base-CAS; instead, a bounded mergeability poll
  (`createMergePullRequest`) pins the `head_sha`, retries 405/409, and fails
  fast on 403/422/5xx.
- A fail-closed post-merge proof (`landedCommitProofError`) validates:
  `merged:true` + `main==sha` + single parent + `tree(landed)==tree(candidate
  prefix)` + `merged_at`.

**Source:** `2026-07-15-merge-train-completion-semantics.md`

### 2. MERGE_TRAIN_MODE deprecated; MERGE_QUEUE_ENABLED is live (2026-07-22)

`MERGE_TRAIN_MODE` is removed. `MERGE_QUEUE_ENABLED` is read by
`auto-rebase-prs.yml` to disable auto-rebase when the merge queue is active.

**Source:** `2026-07-15-merge-train-ruleset-bypass-fix.md`

### 3. Wake-up mechanism: explicit dispatch after check write (2026-07-15)

`Merge Train Validation` dispatches `merge-train.yml` in a **separate step**
after writing the immutable candidate check, preventing the previous silent-miss
scenario (reconcile started with stale data before the check was visible).

Wakeups use `GITHUB_TOKEN` (not the App promotion token): the App token gets 403
on `workflow_dispatch`.

**Source:** `2026-07-15-merge-train-wakeups.md`; confirmed in
`2026-07-16-merge-train-wakeup-gaps.md`

### 4. Concurrency: job-level `queue: single`, not workflow-level (2026-07-16)

Changed from `queue: max` at workflow level to `queue: single` at job level.
Effect: active reconciliation is never cancelled, only pending runs are queued.
Prevents the race where a concurrent reconcile started on a stale candidate.

**Source:** `2026-07-16-merge-train-scheduling.md`

### 5. Bypass: rulesets vs. classic branch protection (2026-07-15)

Rulesets and classic branch protection are **different feature surfaces** with
no overlap in bypass semantics. Admin bypass of a classic protection rule does
NOT bypass a ruleset. Always check via `gh api` which surface is actually active
before assuming permission paths.

**Source:** `2026-07-15-merge-train-ruleset-bypass-fix.md`

### 6. TOCTOU guard and TOCTOU deadlock fix (2026-07-22)

`assertPrHeadUnchangedOrThrow` is a safety guard in `ci-recovery/reconcile.mjs`
that re-fetches the live head and aborts if the PR rebased between review and
mutation. Bug: the guard was passed the _reviewed-at_ commit sha (stale) instead
of `pr.head.sha` (the reconcile's operating head), causing a permanent deadlock
for any PR that was reviewed then later rebased.

Fix: pass `pr.head.sha` at both call sites. `markerHeadSha` (the old reviewed
sha used for dedup) is unchanged.

**Source:** `2026-07-22-merge-train-admission-deadlock.md`

---

## Known Failure Patterns and Mitigations

| Symptom | Root cause | Fix applied |
|---------|-----------|-------------|
| `"CI recovery admission evidence is stale"` for all PRs | TOCTOU guard passed stale sha (Vector A, Jul 22) | Pass `pr.head.sha` — merged PR #1800 |
| `workflow_dispatch` 403 from wakeup step | App token instead of GITHUB_TOKEN | Use `GITHUB_TOKEN` for dispatch |
| Promotion gives `merged:false, merged_at:null` | Force-push instead of squash-merge | Replace with `POST /pulls/{n}/merge` — merged PR #1159+ |
| Reconcile cancels active run | Workflow-level `queue: max` | Switch to job-level `queue: single` |
| `ERR_MODULE_NOT_FOUND` in test run | Stale `node_modules` | Run `npm install` before assuming regression |
| Doc-parsing tests broken by prose rewrites | Literal spaces in regex | Use `\s+` — see `merge-train-doc-rollback-ordering.test.ts` |

---

## Lessons Learned (Aggregated)

- **Force-push ≠ merge semantics.** GitHub sets `merged:true` exclusively through
  its own merge machinery. If the requirement is `state=MERGED`, you must use the
  merge API.
- **Eventually-consistent signals are not ground truth.** `state===closed` was
  used as a surrogate for `merged`; this was wrong at scale (7 PRs with
  `merged:false`). Use `merged:true` as the direct gate.
- **Adversarial plan review earned its keep** on the completion-semantics change:
  it caught that "replace only the push" drops exact-SHA validation and
  cross-PR atomicity, both material, both fixed before code shipped.
- **Wakeup tokens matter.** The App token that triggers most CI steps cannot
  dispatch `workflow_dispatch`; always use `GITHUB_TOKEN` for explicit wakeups.
- **Stale `node_modules` cause confusing multi-file test failures.** Run
  `npm install` before concluding a failure is real.
- **Doc-parsing tests need loose whitespace regexes.** Literal spaces in patterns
  break when surrounding prose is reformatted.

---

## Source Handoffs (for full detail)

| Date | Slug | Summary |
|------|------|---------|
| 2026-07-11 | `2026-07-11-speculative-merge-train` | Initial speculative merge-train design and launch |
| 2026-07-14 | `2026-07-14-merge-train-rollout-fix` | Rollout issues: badge check, label handling |
| 2026-07-15 | `2026-07-15-merge-train-completion-semantics` | **Core redesign**: force-push→squash-merge, proof, ADR amendment |
| 2026-07-15 | `2026-07-15-merge-train-batch-promotion-postcondition-fix` | Postcondition check publishing fix |
| 2026-07-15 | `2026-07-15-merge-train-confirmation-predicate-fix` | Predicate for confirmation check |
| 2026-07-15 | `2026-07-15-merge-train-live-cutover-verified` | Live verification of squash-merge promotion |
| 2026-07-15 | `2026-07-15-merge-train-rollback-status-hydration-fix` | Rollback status hydration |
| 2026-07-15 | `2026-07-15-merge-train-ruleset-bypass-fix` | Ruleset vs. classic protection bypass semantics |
| 2026-07-15 | `2026-07-15-merge-train-wakeups` | Explicit dispatch wakeup after check write |
| 2026-07-16 | `2026-07-16-merge-train-scheduling` | Job-level `queue: single` for concurrency |
| 2026-07-16 | `2026-07-16-merge-train-wakeup-gaps` | Wakeup gap close-out (complement to Jul-15) |
| 2026-07-22 | `2026-07-22-merge-train-admission-deadlock` | TOCTOU guard deadlock (two independent bugs) |

---

## What to Read Next

- **ADR 0060** — original merge-train design document
- **ADR 0062** — amended to replace force-push with squash-merge
- `.github/scripts/merge-train/reconcile-lib.mjs` — promotion and proof logic
- `.github/scripts/merge-train/reconcile.mjs` — admission and orchestration
- `2026-07-22-reconciler-review-gating.md` — Copilot re-review under reconciler control
