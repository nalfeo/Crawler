# Session Handoff: Scope PR Ready/Reviewer Guard concurrency per-PR

## Date

2026-06-25

## Persona(s) adopted

Producer (DevOps Engineer slice) — a CI/workflow-only configuration change with no
src/ or lab impact, so the Producer's ops-leaning slice fits and no specialist routing
was required.

## Routing verdict

✅ right persona — single-file CI config tweak, no multi-layer coordination needed.

## Apples

Estimated: 🍎 x 1
Actual: 🍎 x 1
Verdict: 🎯 Exact — one-line concurrency-group expression change in a single workflow file.

Hello kitties: 1/5 = 0.20 🎀

## What Was Done

- Fixed a CI concurrency quirk in `.github/workflows/pr-ready-reviewer-guard.yml`.
- Changed the job's concurrency group from the global, keyless
  `pr-ready-reviewer-guard` to a per-PR-scoped
  `pr-ready-reviewer-guard-${{ github.event.pull_request.number || github.ref }}`.
- Kept `cancel-in-progress: false`, all triggers, permissions, and the github-script
  step unchanged.

### Root cause

The guard runs on `schedule`, `pull_request_target`
(opened/reopened/synchronize/ready_for_review/review_requested), and
`workflow_dispatch`. It declared a single global concurrency group with no per-PR key.
GitHub keeps at most one PENDING run per concurrency group, so when the `rebase-prs`
bot force-pushes several branches in a short window (firing many `synchronize`
events), each newly-queued run evicts the previously-pending one. The evicted run
surfaces as CANCELLED, and `gh pr checks` mislabels that CANCELLED state as `fail` —
producing misleading red status during busy merge windows. The check is advisory: the
only required contexts are `ci` and `commit-lint`, so it never actually blocked a
merge, but the noise was independently flagged by three shepherd sessions.

### Fix rationale

- For the `pull_request_target` triggers, `github.event.pull_request.number` resolves to
  the PR number, so runs for different PRs land in different groups and no longer evict
  each other's pending run.
- For `schedule` / `workflow_dispatch` (no `pull_request` in the event), the expression
  falls back to `github.ref` (a stable `refs/heads/<default-branch>`), so concurrent
  scheduled/dispatch runs still serialize under one stable group rather than running
  unbounded.

## What's Next

- Nothing required. Optional future cleanup: the guard could also be narrowed to skip
  the full open-PR scan on per-PR events, but that is out of scope for this concurrency
  fix.

## Blockers

None.

## Branch State

- Branch: `nalfeo-fix-pr-guard-concurrency`
- All tests passing: yes (`npm run verify:fast`)
- PR created: yes (see PR link in session report)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session, so no guard-telemetry
section is included.

## Test Results

- `bash scripts/agent/preflight.sh` → ✅ Environment ready
- `npm run verify:fast` → ✅ Fast verification passed (typecheck + lint + unit tests)
- `bash scripts/agent/lab-gate-check.sh` → ✅ Lab gate check passed (every system has a lab)
- Workflow YAML validated with `yaml.parse` — parses cleanly; concurrency group now
  per-PR scoped.

## Key Decisions Made

- Used `github.event.pull_request.number || github.ref` (not `github.head_ref`) so the
  fallback is stable and sensible for non-PR (scheduled/dispatch) runs, keeping them
  serialized instead of unbounded.
- Left `cancel-in-progress: false` intact — the goal is to stop cross-PR eviction, not
  to start cancelling in-flight runs.
