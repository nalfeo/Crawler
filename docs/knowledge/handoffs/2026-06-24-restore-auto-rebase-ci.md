# Handoff: Restore auto-rebase PR automation

**Date:** 2026-06-24
**Apple estimate:** 🍎
**Apple actual:** 🍎
**Verdict:** 🎯 Exact

## Summary

Restored the `auto-rebase-prs.yml` workflow that was removed in PR #260
(commit `4467640`, "ci: remove session guard, auto-rebase, and review-ping
workflows"). The user asked to bring back the automation that forces a
merge/rebase of all active PRs whenever another PR completes.

The workflow's `push: branches: [main]` trigger is exactly that behavior: when
a PR merges to `main`, the push fires the workflow, which rebases every open,
non-draft, same-repo PR branch onto the new `main` and force-pushes with
`--force-with-lease`. It also keeps the hourly `schedule`, `pull_request`
(opened/reopened), and `workflow_dispatch` triggers from the original.

On a rebase conflict it files (or reuses) a `merge-conflict` labelled issue
assigned to Copilot, and closes those issues automatically once the branch
rebases cleanly or the PR is no longer open.

## Files touched

- `.github/workflows/auto-rebase-prs.yml` (restored verbatim from `4467640^`)
- `docs/knowledge/metrics/apples/2026-06-24-restore-auto-rebase-ci.json` (added)
- `docs/knowledge/handoffs/2026-06-24-restore-auto-rebase-ci.md` (this file)

The two sibling workflows removed in the same commit (`copilot-session-guard.yml`,
`copilot-review-ping.yml`) were intentionally **not** restored — out of scope.

## Verification

- Restored content is byte-identical to the pre-deletion original (diff check).
- YAML parses cleanly; 171 LF line endings, 0 CRLF (bash `run:` block intact).
- `npm run verify:fast` passed (typecheck + lint + unit tests).

## Unresolved issues

None.

## Recommended next steps

- The workflow needs no secrets beyond the default `GITHUB_TOKEN`.
- If repo branch protection blocks bot force-pushes to PR branches, confirm the
  `github-actions[bot]` identity is permitted, otherwise rebases will be filed
  as conflict issues instead of applied.
